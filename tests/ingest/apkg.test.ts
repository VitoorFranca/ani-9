import { afterEach, describe, expect, it } from "vitest";
import { openApkgDatabase } from "../../src/ingest/apkg.js";
import { readCollection } from "../../src/ingest/schema.js";
import { buildApkg } from "../fixtures/build-apkg.js";

describe("apkg ingestion across container formats", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  const noteTypes = [{ id: 1, name: "Basic", fields: ["Front", "Back"] }];
  const notes = [{ id: 10, guid: "abc", mid: 1, tags: "tag1", flds: "Hello\x1fOla" }];
  const cards = [{ id: 100, nid: 10, did: 1, ord: 0 }];
  const revlog = [{ id: 1000, cid: 100, ease: 3, factor: 2500, type: 1 }];

  it("reads legacy collection.anki2 (col.models JSON)", async () => {
    const buf = await buildApkg({ container: "anki2", schema: "legacy", noteTypes, notes, cards, revlog });
    const { db, cleanup } = await openApkgDatabase(buf);
    cleanups.push(cleanup);
    const col = readCollection(db);
    db.close();

    expect(col.notes).toHaveLength(1);
    expect(col.noteTypes.get(1)?.name).toBe("Basic");
    expect(col.noteTypes.get(1)?.fields).toEqual(["Front", "Back"]);
  });

  it("reads legacy collection.anki21 (col.models JSON)", async () => {
    const buf = await buildApkg({ container: "anki21", schema: "legacy", noteTypes, notes, cards, revlog });
    const { db, cleanup } = await openApkgDatabase(buf);
    cleanups.push(cleanup);
    const col = readCollection(db);
    db.close();

    expect(col.cards).toHaveLength(1);
    expect(col.noteTypes.get(1)?.fields).toEqual(["Front", "Back"]);
  });

  it("reads current collection.anki21b (zstd + normalized notetypes/fields)", async () => {
    const buf = await buildApkg({ container: "anki21b", schema: "normalized", noteTypes, notes, cards, revlog });
    const { db, cleanup } = await openApkgDatabase(buf);
    cleanups.push(cleanup);
    const col = readCollection(db);
    db.close();

    expect(col.revlog).toHaveLength(1);
    // Field names aren't read for the normalized schema (see build-apkg.ts) —
    // only id/name, which content extraction doesn't need.
    expect(col.noteTypes.get(1)?.name).toBe("Basic");
    expect(col.noteTypes.get(1)?.fields).toEqual([]);
  });

  it("prefers anki21b over the accompanying legacy stub", async () => {
    const buf = await buildApkg({
      container: "anki21b",
      schema: "normalized",
      noteTypes,
      notes,
      cards,
      revlog,
      includeStub: true,
    });
    const { db, cleanup } = await openApkgDatabase(buf);
    cleanups.push(cleanup);
    const col = readCollection(db);
    db.close();

    // The stub collection.anki2 is empty; if it were picked instead this would throw.
    expect(col.notes).toHaveLength(1);
  });

  it("splits note fields on the unit separator and parses tags", async () => {
    const buf = await buildApkg({ container: "anki2", schema: "legacy", noteTypes, notes, cards, revlog });
    const { db, cleanup } = await openApkgDatabase(buf);
    cleanups.push(cleanup);
    const col = readCollection(db);
    db.close();

    expect(col.notes[0]?.fields).toEqual(["Hello", "Ola"]);
    expect(col.notes[0]?.tags).toEqual(["tag1"]);
  });

  it("throws a clear error when no recognized collection database is present", async () => {
    const { zipSync } = await import("fflate");
    const empty = Buffer.from(zipSync({ "meta": new Uint8Array(0) }));
    await expect(openApkgDatabase(empty)).rejects.toThrow(/No recognized Anki collection database/);
  });
});
