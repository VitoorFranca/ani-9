import { describe, expect, it } from "vitest";
import { canonicalizeConcepts } from "../../src/concepts/canonicalize.js";
import type { EmbedResult, EmbeddingKind, TextEmbedder } from "../../src/embeddings/embed.js";

/** A fake embedder: gives near-identical vectors to names sharing the same group tag. */
function fakeEmbedder(groupOf: Record<string, number>): TextEmbedder {
  return {
    async embed(texts: readonly string[], _kind: EmbeddingKind): Promise<EmbedResult> {
      const vectors = texts.map((t) => {
        const group = groupOf[t] ?? -1;
        // One-hot-ish vector per group, so same-group names are identical
        // (similarity 1) and different groups are orthogonal (similarity 0).
        const v = new Array(10).fill(0);
        if (group >= 0) v[group] = 1;
        return v;
      });
      return { vectors, cacheHits: 0 };
    },
  };
}

describe("canonicalizeConcepts", () => {
  it("merges concepts whose embeddings are similar above the threshold", async () => {
    const embedder = fakeEmbedder({ car: 0, automobile: 0, house: 1 });
    const counts = new Map([
      ["car", 5],
      ["automobile", 2],
      ["house", 3],
    ]);

    const { canonicalNameByOriginal, merges } = await canonicalizeConcepts(counts, embedder, 0.88);

    expect(canonicalNameByOriginal.get("automobile")).toBe("car"); // "car" is more frequent
    expect(canonicalNameByOriginal.get("car")).toBe("car");
    expect(canonicalNameByOriginal.get("house")).toBe("house");
    expect(merges).toEqual([{ canonical: "car", mergedFrom: ["automobile"] }]);
  });

  it("does not merge concepts below the similarity threshold", async () => {
    const embedder = fakeEmbedder({ car: 0, house: 1 });
    const counts = new Map([
      ["car", 1],
      ["house", 1],
    ]);
    const { merges, canonicalNameByOriginal } = await canonicalizeConcepts(counts, embedder, 0.88);
    expect(merges).toEqual([]);
    expect(canonicalNameByOriginal.get("car")).toBe("car");
    expect(canonicalNameByOriginal.get("house")).toBe("house");
  });

  it("breaks ties in canonical-name selection alphabetically", async () => {
    const embedder = fakeEmbedder({ zebra: 0, apple: 0 });
    const counts = new Map([
      ["zebra", 3],
      ["apple", 3],
    ]);
    const { canonicalNameByOriginal } = await canonicalizeConcepts(counts, embedder, 0.88);
    expect(canonicalNameByOriginal.get("zebra")).toBe("apple");
    expect(canonicalNameByOriginal.get("apple")).toBe("apple");
  });

  it("handles three-way merges via transitive union-find", async () => {
    const embedder = fakeEmbedder({ a: 0, b: 0, c: 0 });
    const counts = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 1],
    ]);
    const { canonicalNameByOriginal, merges } = await canonicalizeConcepts(counts, embedder, 0.88);
    expect(canonicalNameByOriginal.get("a")).toBe("b");
    expect(canonicalNameByOriginal.get("c")).toBe("b");
    expect(merges).toHaveLength(1);
    expect(merges[0]?.canonical).toBe("b");
    expect(merges[0]?.mergedFrom.sort()).toEqual(["a", "c"]);
  });

  it("returns empty results for no concepts", async () => {
    const embedder = fakeEmbedder({});
    const { canonicalNameByOriginal, merges } = await canonicalizeConcepts(new Map(), embedder);
    expect(canonicalNameByOriginal.size).toBe(0);
    expect(merges).toEqual([]);
  });
});
