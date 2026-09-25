import { describe, expect, it } from "vitest";
import { computeNeighborSets } from "../../src/model/neighbors.js";
import type { EmbedResult, EmbeddingKind, TextEmbedder } from "../../src/embeddings/embed.js";

function fakeEmbedder(vectorByText: Record<string, number[]>): TextEmbedder {
  return {
    async embed(texts: readonly string[], _kind: EmbeddingKind): Promise<EmbedResult> {
      return { vectors: texts.map((t) => vectorByText[t] ?? [0, 0]), cacheHits: 0 };
    },
  };
}

describe("computeNeighborSets", () => {
  it("ranks the embedding-identical card as the top neighbor", async () => {
    const cards = [
      { cardId: 1, front: "a" },
      { cardId: 2, front: "b" },
      { cardId: 3, front: "c" },
    ];
    // a and b get identical embeddings; c is orthogonal.
    const embedder = fakeEmbedder({ a: [1, 0], b: [1, 0], c: [0, 1] });

    const { embedding } = await computeNeighborSets(cards, embedder, 2);
    expect(embedding.get(1)?.[0]?.cardId).toBe(2);
    expect(embedding.get(1)?.[0]?.weight).toBeCloseTo(1);
  });

  it("never includes a card as its own neighbor", async () => {
    const cards = [
      { cardId: 1, front: "a" },
      { cardId: 2, front: "b" },
    ];
    const embedder = fakeEmbedder({ a: [1, 0], b: [1, 0] });
    const { embedding, bm25, average } = await computeNeighborSets(cards, embedder, 5);
    for (const set of [embedding, bm25, average]) {
      for (const [cardId, neighbors] of set) {
        expect(neighbors.some((n) => n.cardId === cardId)).toBe(false);
      }
    }
  });

  it("ranks lexically overlapping cards higher via bm25, independent of embeddings", async () => {
    const cards = [
      { cardId: 1, front: "the farmer walked to the market" },
      { cardId: 2, front: "the farmer went to the market" },
      { cardId: 3, front: "completely unrelated text about something else" },
    ];
    // Make embeddings uninformative (all identical) so bm25 alone drives the ranking.
    const embedder = fakeEmbedder({
      "the farmer walked to the market": [1, 0],
      "the farmer went to the market": [1, 0],
      "completely unrelated text about something else": [1, 0],
    });

    const { bm25 } = await computeNeighborSets(cards, embedder, 2);
    expect(bm25.get(1)?.[0]?.cardId).toBe(2);
  });

  it("returns weights normalized to [0,1]", async () => {
    const cards = [
      { cardId: 1, front: "the farmer walked" },
      { cardId: 2, front: "the farmer ran" },
      { cardId: 3, front: "nothing in common here" },
    ];
    const embedder = fakeEmbedder({
      "the farmer walked": [1, 0],
      "the farmer ran": [0.9, 0.1],
      "nothing in common here": [0, 1],
    });
    const { embedding, bm25, average } = await computeNeighborSets(cards, embedder, 5);
    for (const set of [embedding, bm25, average]) {
      for (const neighbors of set.values()) {
        for (const n of neighbors) {
          expect(n.weight).toBeGreaterThanOrEqual(0);
          expect(n.weight).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("gives a card with no genuinely related neighbor a low weight, not a forced 1.0 (global, not per-row, scaling)", async () => {
    // Two near-duplicate cards (a, b), plus an isolated card (c) whose best
    // match is still fairly distant from everything. Per-row min-max
    // normalization would force c's top neighbor to weight 1.0 regardless;
    // global normalization should keep it low since a<->b is far more
    // similar than c is to anything.
    const embedder = fakeEmbedder({
      a: [1, 0, 0],
      b: [0.99, 0.01, 0],
      c: [0.3, 0.3, 0.9], // clearly less similar to a or b than they are to each other
    });
    const cards = [
      { cardId: 1, front: "a" },
      { cardId: 2, front: "b" },
      { cardId: 3, front: "c" },
    ];
    const { embedding } = await computeNeighborSets(cards, embedder, 2);

    const aTopWeight = embedding.get(1)?.[0]?.weight ?? 0;
    const cTopWeight = embedding.get(3)?.[0]?.weight ?? 0;
    expect(aTopWeight).toBeGreaterThan(0.9); // a<->b: near-duplicate
    expect(cTopWeight).toBeLessThan(0.5); // c: no real match, should NOT be forced to ~1.0
  });

  it("limits results to k neighbors", async () => {
    const cards = Array.from({ length: 10 }, (_, i) => ({ cardId: i, front: `card number ${i}` }));
    const vectorByText = Object.fromEntries(cards.map((c) => [c.front, [Math.random(), Math.random()]]));
    const embedder = fakeEmbedder(vectorByText);
    const { embedding } = await computeNeighborSets(cards, embedder, 3);
    expect(embedding.get(0)).toHaveLength(3);
  });
});
