import { readFile } from "node:fs/promises";
import { openApkgDatabase } from "./apkg.js";
import { readCollection } from "./schema.js";
import { filterRevlog } from "./revlog-filter.js";
import type { AnkiCollection, Review } from "./types.js";

export * from "./types.js";
export { openApkgDatabase } from "./apkg.js";
export { readCollection } from "./schema.js";
export { filterRevlog } from "./revlog-filter.js";

export interface IngestResult {
  collection: AnkiCollection;
  reviews: Review[];
}

export async function ingestApkgFile(path: string): Promise<IngestResult> {
  const buffer = await readFile(path);
  const { db, cleanup } = await openApkgDatabase(buffer);
  try {
    const collection = readCollection(db);
    const reviews = filterRevlog(collection.revlog);
    return { collection, reviews };
  } finally {
    db.close();
    cleanup();
  }
}
