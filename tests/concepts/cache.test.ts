import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConceptCache, hashCardContent } from "../../src/concepts/cache.js";

describe("hashCardContent", () => {
  it("differs by model", () => {
    expect(hashCardContent("model-a", "text")).not.toBe(hashCardContent("model-b", "text"));
  });

  it("differs by text", () => {
    expect(hashCardContent("model-a", "text-1")).not.toBe(hashCardContent("model-a", "text-2"));
  });

  it("is stable for the same inputs", () => {
    expect(hashCardContent("model-a", "text")).toBe(hashCardContent("model-a", "text"));
  });
});

describe("ConceptCache", () => {
  let dir: string;
  let cache: ConceptCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ani9-concept-cache-"));
    cache = new ConceptCache(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null on a miss and the stored value after a set", async () => {
    const hash = hashCardContent("model-a", "hello");
    expect(await cache.get(hash)).toBeNull();

    await cache.set(hash, [{ name: "greeting", weight: 0.8 }]);
    expect(await cache.get(hash)).toEqual([{ name: "greeting", weight: 0.8 }]);
  });
});
