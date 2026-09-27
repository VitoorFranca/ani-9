import type Database from "better-sqlite3";
import type { AnkiCollection, NoteType, RawCard, RawNote, RawRevlogEntry } from "./types.js";

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`select name from sqlite_master where type = 'table' and name = ?`)
    .get(name);
  return row != null;
}

/**
 * Current schema (2020+): notetypes normalized into their own table.
 *
 * We deliberately do NOT query the `fields` table here. It (like
 * `templates`, `decks`, `tags`) is a `WITHOUT ROWID` table whose `name`
 * column uses Anki's custom `unicase` collation, which isn't registered in
 * better-sqlite3's bundled SQLite — even a plain `SELECT` or `count(*)`
 * against such a table fails with "no query solution" (verified against a
 * real collection). `notetypes` itself is a normal ROWID table, so plain
 * id/name lookups on it work fine and don't need the collation. Field
 * *names* aren't needed downstream: content extraction is positional over
 * `notes.flds`, not keyed by field name.
 */
function readNoteTypesNormalized(db: Database.Database): Map<number, NoteType> {
  const noteTypeRows = db.prepare(`select id, name from notetypes`).all() as {
    id: number;
    name: string;
  }[];

  const result = new Map<number, NoteType>();
  for (const nt of noteTypeRows) {
    result.set(nt.id, { id: nt.id, name: nt.name, fields: [] });
  }
  return result;
}

interface LegacyModel {
  id?: number;
  name: string;
  flds: { name: string; ord: number }[];
}

/** Legacy schema (pre-2020): notetypes live in the `col.models` JSON blob. */
function readNoteTypesLegacy(db: Database.Database): Map<number, NoteType> {
  const row = db.prepare(`select models from col`).get() as { models: string };
  const parsed = JSON.parse(row.models) as Record<string, LegacyModel>;

  const result = new Map<number, NoteType>();
  for (const [key, model] of Object.entries(parsed)) {
    const id = model.id ?? Number(key);
    const fields = [...model.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name);
    result.set(id, { id, name: model.name, fields });
  }
  return result;
}

function readNoteTypes(db: Database.Database): Map<number, NoteType> {
  return tableExists(db, "notetypes") ? readNoteTypesNormalized(db) : readNoteTypesLegacy(db);
}

function readNotes(db: Database.Database): RawNote[] {
  const rows = db.prepare(`select id, guid, mid, tags, flds from notes`).all() as {
    id: number;
    guid: string;
    mid: number;
    tags: string;
    flds: string;
  }[];

  return rows.map((r) => ({
    id: r.id,
    guid: r.guid,
    modelId: r.mid,
    tags: r.tags.split(" ").map((t) => t.trim()).filter(Boolean),
    fields: r.flds.split("\x1f"),
  }));
}

function readCards(db: Database.Database): RawCard[] {
  const rows = db.prepare(`select id, nid, did, ord from cards`).all() as {
    id: number;
    nid: number;
    did: number;
    ord: number;
  }[];

  return rows.map((r) => ({ id: r.id, noteId: r.nid, deckId: r.did, ord: r.ord }));
}

function readRevlog(db: Database.Database): RawRevlogEntry[] {
  const rows = db.prepare(`select id, cid, ease, factor, type from revlog order by id asc`).all() as {
    id: number;
    cid: number;
    ease: number;
    factor: number;
    type: number;
  }[];

  return rows.map((r) => ({ id: r.id, cardId: r.cid, ease: r.ease, factor: r.factor, type: r.type }));
}

export function readCollection(db: Database.Database): AnkiCollection {
  return {
    noteTypes: readNoteTypes(db),
    notes: readNotes(db),
    cards: readCards(db),
    revlog: readRevlog(db),
  };
}
