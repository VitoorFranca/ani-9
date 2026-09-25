import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface EmbeddingCacheEntry {
  model: string;
  text: string;
  vector: number[];
}

/** Disk cache for embedding vectors, indexed by hash(model + text). */
export class EmbeddingCache {
  constructor(private readonly dir: string) {}

  private pathFor(model: string, text: string): string {
    const hash = createHash("sha256").update(model).update("\u0000").update(text).digest("hex");
    return join(this.dir, `${hash}.json`);
  }

  async get(model: string, text: string): Promise<number[] | null> {
    try {
      const raw = await readFile(this.pathFor(model, text), "utf8");
      return (JSON.parse(raw) as EmbeddingCacheEntry).vector;
    } catch {
      return null;
    }
  }

  async set(model: string, text: string, vector: readonly number[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entry: EmbeddingCacheEntry = { model, text, vector: [...vector] };
    await writeFile(this.pathFor(model, text), JSON.stringify(entry));
  }
}
