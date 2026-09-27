import { cosineSimilarity, type TextEmbedder } from "../embeddings/embed.js";
import { buildBm25Index, tokenize } from "./bm25.js";

export interface Neighbor {
  cardId: number;
  /**
   * Similarity on an absolute, corpus-wide [0,1] scale — NOT normalized
   * per-row. Per-row min-max normalization was tried first and abandoned:
   * it forces every card's single best match to weight 1.0 regardless of
   * whether the true similarity is 0.99 or 0.3, which (confirmed against
   * real data) makes even a card with no genuinely related neighbor inject
   * full-strength transfer — the likely cause of a severe calibration
   * collapse (RMSE 0.037 -> ~0.21) when this was fed into the Bayesian
   * model. Embedding similarity is raw cosine, clipped to [0,1] (negative
   * similarity contributes nothing). BM25 has no natural upper bound, so
   * it's min-max normalized using the GLOBAL min/max over the whole matrix
   * (not per row), which preserves "this card has no good match at all"
   * as a real, low, comparable-across-cards signal instead of erasing it.
   */
  weight: number;
}

export type NeighborMethod = "embedding" | "bm25" | "average";

export type NeighborSets = Record<NeighborMethod, Map<number, Neighbor[]>>;

function globalNormalize(matrix: readonly (readonly number[])[], excludeDiagonal: boolean): number[][] {
  let max = -Infinity;
  let min = Infinity;
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i]!.length; j++) {
      if (excludeDiagonal && i === j) continue;
      const v = matrix[i]![j]!;
      if (v > max) max = v;
      if (v < min) min = v;
    }
  }
  if (max === min) return matrix.map((row) => row.map(() => 0));
  return matrix.map((row) => row.map((v) => (v - min) / (max - min)));
}

function topKFromMatrix(
  matrix: readonly (readonly number[])[],
  cardIds: readonly number[],
  k: number,
): Map<number, Neighbor[]> {
  const result = new Map<number, Neighbor[]>();
  for (let i = 0; i < cardIds.length; i++) {
    const row = matrix[i]!;
    const scored = row
      .map((weight, j) => ({ cardId: cardIds[j]!, weight, index: j }))
      .filter((entry) => entry.index !== i)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, k)
      .map(({ cardId, weight }) => ({ cardId, weight }));
    result.set(cardIds[i]!, scored);
  }
  return result;
}

/**
 * Computes each card's top-k neighbors three ways: local embedding cosine
 * similarity, BM25 over the question ("front") text, and their average
 * (both put on a comparable absolute [0,1] scale — see `Neighbor.weight` —
 * before averaging). All local — no LLM calls. Similarity is computed over
 * `front` only (the studied content), not `back` (translation/answer
 * gloss), matching the same content-vs-translation-language distinction
 * the extraction prompt now applies.
 */
export async function computeNeighborSets(
  cards: readonly { cardId: number; front: string }[],
  embedder: TextEmbedder,
  k = 5,
): Promise<NeighborSets> {
  const cardIds = cards.map((c) => c.cardId);
  const n = cardIds.length;

  const { vectors } = await embedder.embed(
    cards.map((c) => c.front),
    "query",
  );
  const embeddingMatrix: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) embeddingMatrix[i]![j] = Math.max(0, cosineSimilarity(vectors[i]!, vectors[j]!));
    }
  }

  const bm25Index = buildBm25Index(cards.map((c) => c.front));
  const queryTokens = cards.map((c) => tokenize(c.front));
  const bm25RawMatrix: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) bm25RawMatrix[i]![j] = bm25Index.scoreAgainst(queryTokens[i]!, j);
    }
  }
  const bm25Matrix = globalNormalize(bm25RawMatrix, true);

  const averageMatrix: number[][] = Array.from({ length: n }, (_, i) =>
    embeddingMatrix[i]!.map((v, j) => (v + bm25Matrix[i]![j]!) / 2),
  );

  return {
    embedding: topKFromMatrix(embeddingMatrix, cardIds, k),
    bm25: topKFromMatrix(bm25Matrix, cardIds, k),
    average: topKFromMatrix(averageMatrix, cardIds, k),
  };
}
