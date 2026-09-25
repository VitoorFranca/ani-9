import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Embedder, cosineSimilarity } from "../../src/embeddings/embed.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("is -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("is 0 when a vector is all zeros (avoids NaN from division by zero)", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

// Runs the real transformers.js pipeline (not mocked) to catch model/API
// issues, matching this project's "confirm the API against the real thing"
// rule. Slow: downloads/loads the ONNX model on first run (~20s), so this
// suite uses a generous timeout and a persistent model cache dir.
describe("Embedder", () => {
  let vectorCacheDir: string;
  let embedder: Embedder;

  beforeEach(() => {
    vectorCacheDir = mkdtempSync(join(tmpdir(), "ani9-embed-vectors-"));
    embedder = new Embedder({ cacheDir: vectorCacheDir, modelCacheDir: "./.cache/models" });
  });

  afterEach(() => {
    rmSync(vectorCacheDir, { recursive: true, force: true });
  });

  it(
    "embeds text into a 384-dim normalized vector and caches it on disk",
    async () => {
      const first = await embedder.embed(["hello world"], "query");
      expect(first.vectors).toHaveLength(1);
      expect(first.vectors[0]).toHaveLength(384);
      expect(first.cacheHits).toBe(0);

      const magnitude = Math.sqrt(first.vectors[0]!.reduce((s, v) => s + v * v, 0));
      expect(magnitude).toBeCloseTo(1, 1); // normalize: true

      const second = await embedder.embed(["hello world"], "query");
      expect(second.cacheHits).toBe(1);
      expect(second.vectors[0]).toEqual(first.vectors[0]);
    },
    60_000,
  );

  it(
    "gives semantically similar sentences a higher cosine similarity than unrelated ones",
    async () => {
      const { vectors } = await embedder.embed(
        ["The cat sat on the mat", "A feline rested on the rug", "Quantum physics is fascinating"],
        "passage",
      );
      const [catMat, felineRug, physics] = vectors as [number[], number[], number[]];

      const similarPair = cosineSimilarity(catMat, felineRug);
      const dissimilarPair = cosineSimilarity(catMat, physics);
      expect(similarPair).toBeGreaterThan(dissimilarPair);
    },
    60_000,
  );
});
