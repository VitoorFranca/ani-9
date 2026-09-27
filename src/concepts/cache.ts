import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtractedConcept } from "./types.js";

/** Keyed by model too, not just content: switching --model must not reuse stale extractions. */
export function hashCardContent(model: string, text: string): string {
  return createHash("sha256").update(model).update("\u0000").update(text).digest("hex");
}

export class ConceptCache {
  constructor(private readonly dir: string) {}

  private pathFor(hash: string): string {
    return join(this.dir, `${hash}.json`);
  }

  async get(hash: string): Promise<ExtractedConcept[] | null> {
    try {
      const raw = await readFile(this.pathFor(hash), "utf8");
      return JSON.parse(raw) as ExtractedConcept[];
    } catch {
      return null;
    }
  }

  async set(hash: string, concepts: readonly ExtractedConcept[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathFor(hash), JSON.stringify(concepts));
  }
}
