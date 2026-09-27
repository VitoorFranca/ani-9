import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmbeddingCache } from "../../src/embeddings/cache.js";

describe("EmbeddingCache", () => {
  let dir: string;
  let cache: EmbeddingCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ani9-embed-cache-"));
    cache = new EmbeddingCache(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for a cache miss", async () => {
    expect(await cache.get("model-a", "hello")).toBeNull();
  });

  it("returns the stored vector after a set", async () => {
    await cache.set("model-a", "hello", [1, 2, 3]);
    expect(await cache.get("model-a", "hello")).toEqual([1, 2, 3]);
  });

  it("keys by model AND text — same text, different model misses", async () => {
    await cache.set("model-a", "hello", [1, 2, 3]);
    expect(await cache.get("model-b", "hello")).toBeNull();
  });

  it("keys by text — same model, different text misses", async () => {
    await cache.set("model-a", "hello", [1, 2, 3]);
    expect(await cache.get("model-a", "world")).toBeNull();
  });
});
