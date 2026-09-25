import { unzipSync } from "fflate";
import { decompress } from "@mongodb-js/zstd";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB_CANDIDATES = [
  "collection.anki21b",
  "collection.anki21",
  "collection.anki2",
] as const;

/**
 * Opens the SQLite collection database embedded in a .apkg file.
 * Anki has shipped three container generations; a modern export includes
 * a stub `collection.anki2` alongside the real db, so we must check in
 * newest-first order rather than picking whichever file exists.
 *
 * better-sqlite3's Buffer-based in-memory constructor (`new Database(buf)`)
 * opens but fails to deserialize real data in this build (SQLITE_CANTOPEN on
 * first query), so the decompressed db is written to a temp file instead.
 */
export async function openApkgDatabase(
  apkgBuffer: Buffer,
): Promise<{ db: Database.Database; cleanup: () => void }> {
  const entries = unzipSync(new Uint8Array(apkgBuffer));

  for (const name of DB_CANDIDATES) {
    const entry = entries[name];
    if (!entry) continue;

    const raw = Buffer.from(entry);
    const dbBuffer = name === "collection.anki21b" ? await decompress(raw) : raw;

    const dir = mkdtempSync(join(tmpdir(), "ani9-apkg-"));
    const dbPath = join(dir, "collection.sqlite");
    writeFileSync(dbPath, dbBuffer);

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  throw new Error(
    `No recognized Anki collection database found in .apkg (looked for: ${DB_CANDIDATES.join(", ")})`,
  );
}
