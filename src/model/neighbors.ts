import { cosineSimilarity, type TextEmbedder } from "../embeddings/embed.js";
import { buildBm25Index, tokenize } from "./bm25.js";

export interface Neighbor {
  cardId: number;
  /** Similarity, normalized to [0,1] per source card (min-max over its own row). */
  weight: number;
}

export type NeighborMethod = "embedding" | "bm25" | "average";

export type NeighborSets = Record<NeighborMethod, Map<number, Neighbor[]>>;

function normalizeRow(row: readonly number[]): number[] {
  const max = Math.max(...row);
  const min = Math.min(...row);
  if (max === min) return row.map(() => 0);
  return row.map((v) => (v - min) / (max - min));
}

function topKFromMatrix(matrix: readonly (readonly number[])[], cardIds: readonly number[], k: number): Map<number, Neighbor[]> {
  const result = new Map<number, Neighbor[]>();
  for (let i = 0; i < cardIds.length; i++) {
    const row = matrix[i]!;
    const normalized = normalizeRow(row);
    const scored = normalized
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
 * (each normalized to [0,1] per row before averaging, since raw BM25 scores
 * and cosine similarities live on incomparable scales). All local — no LLM
 * calls. Similarity is computed over `front` only (the studied content),
 * not `back` (translation/answer gloss), matching the same content-vs-
 * translation-language distinction the extraction prompt now applies.
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
      if (i !== j) embeddingMatrix[i]![j] = cosineSimilarity(vectors[i]!, vectors[j]!);
    }
  }

  const bm25Index = buildBm25Index(cards.map((c) => c.front));
  const queryTokens = cards.map((c) => tokenize(c.front));
  const bm25Matrix: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) bm25Matrix[i]![j] = bm25Index.scoreAgainst(queryTokens[i]!, j);
    }
  }

  const embeddingNormalized = embeddingMatrix.map(normalizeRow);
  const bm25Normalized = bm25Matrix.map(normalizeRow);
  const averageMatrix: number[][] = Array.from({ length: n }, (_, i) =>
    embeddingNormalized[i]!.map((v, j) => (v + bm25Normalized[i]![j]!) / 2),
  );

  return {
    embedding: topKFromMatrix(embeddingMatrix, cardIds, k),
    bm25: topKFromMatrix(bm25Matrix, cardIds, k),
    average: topKFromMatrix(averageMatrix, cardIds, k),
  };
}
