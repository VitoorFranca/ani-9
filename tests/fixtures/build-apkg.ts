import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { compress } from "@mongodb-js/zstd";

export type SchemaKind = "legacy" | "normalized";

export interface FixtureNoteType {
  id: number;
  name: string;
  fields: string[];
}

export interface FixtureNote {
  id: number;
  guid: string;
  mid: number;
  tags: string;
  flds: string;
}

export interface FixtureCard {
  id: number;
  nid: number;
  did: number;
  ord: number;
}

export interface FixtureRevlog {
  id: number;
  cid: number;
  ease: number;
  factor: number;
  type: number;
}

interface CollectionSpec {
  schema: SchemaKind;
  noteTypes: FixtureNoteType[];
  notes: FixtureNote[];
  cards: FixtureCard[];
  revlog: FixtureRevlog[];
}

/** Builds a real on-disk SQLite collection db and returns its raw bytes. */
function buildCollectionDb(spec: CollectionSpec): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "ani9-fixture-"));
  const path = join(dir, "collection.sqlite");
  const db = new Database(path);

  db.exec(`
    CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
    CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld integer, csum integer, flags integer, data text);
    CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);
    CREATE TABLE revlog (id integer primary key, cid integer, usn integer, ease integer, ivl integer, lastIvl integer, factor integer, time integer, type integer);
  `);

  let modelsJson = "{}";
  if (spec.schema === "normalized") {
    // Deliberately does NOT create a `fields` table. In real Anki collections
    // that table uses a custom `unicase` collation that isn't registered in
    // better-sqlite3 (or the system sqlite3 CLI, or node:sqlite — none of
    // them expose collation registration, and SQLite requires a collation to
    // exist at CREATE TABLE time, so this can't even be reproduced in a
    // fixture). A WITHOUT ROWID table like `fields` fails on every query,
    // even count(*), once that happens (verified against the real
    // data/CIMV.apkg file). schema.ts's readNoteTypesNormalized() works
    // around this by never touching `fields` at all; omitting the table here
    // proves that code path has no hidden dependency on it.
    db.exec(`CREATE TABLE notetypes (id integer not null primary key, name text not null);`);
    const insertNoteType = db.prepare("insert into notetypes (id, name) values (?, ?)");
    for (const nt of spec.noteTypes) {
      insertNoteType.run(nt.id, nt.name);
    }
  } else {
    const models: Record<string, unknown> = {};
    for (const nt of spec.noteTypes) {
      models[String(nt.id)] = {
        id: nt.id,
        name: nt.name,
        flds: nt.fields.map((f, i) => ({ name: f, ord: i })),
      };
    }
    modelsJson = JSON.stringify(models);
  }

  db.prepare(
    `insert into col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
     values (1, 0, 0, 0, 11, 0, 0, 0, '{}', ?, '{}', '{}', '{}')`,
  ).run(modelsJson);

  const insertNote = db.prepare(
    `insert into notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
     values (?, ?, ?, 0, 0, ?, ?, 0, 0, 0, '')`,
  );
  for (const n of spec.notes) insertNote.run(n.id, n.guid, n.mid, ` ${n.tags} `, n.flds);

  const insertCard = db.prepare(
    `insert into cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
     values (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '')`,
  );
  for (const c of spec.cards) insertCard.run(c.id, c.nid, c.did, c.ord);

  const insertRevlog = db.prepare(
    `insert into revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type)
     values (?, ?, 0, ?, 0, 0, ?, 0, ?)`,
  );
  for (const r of spec.revlog) insertRevlog.run(r.id, r.cid, r.ease, r.factor, r.type);

  db.close();
  const bytes = readFileSync(path);
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

export interface BuildApkgOptions extends CollectionSpec {
  container: "anki2" | "anki21" | "anki21b";
  /** Whether to also include the (empty) legacy stub alongside a modern db. Default true. */
  includeStub?: boolean;
}

/** Builds a minimal, synthetic .apkg zip buffer for a given container generation. */
export async function buildApkg(opts: BuildApkgOptions): Promise<Buffer> {
  const dbBytes = buildCollectionDb(opts);
  const files: Record<string, Uint8Array> = {};

  if (opts.container === "anki21b") {
    files["collection.anki21b"] = new Uint8Array(await compress(dbBytes));
    if (opts.includeStub !== false) files["collection.anki2"] = new Uint8Array(0);
  } else if (opts.container === "anki21") {
    files["collection.anki21"] = new Uint8Array(dbBytes);
    if (opts.includeStub !== false) files["collection.anki2"] = new Uint8Array(0);
  } else {
    files["collection.anki2"] = new Uint8Array(dbBytes);
  }

  return Buffer.from(zipSync(files));
}
