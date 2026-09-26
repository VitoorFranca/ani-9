// Counts only, no effect calculation, per the user's request. No API calls.
import { readdir, readFile } from "node:fs/promises";
import { ingestApkgFile, openApkgDatabase } from "../src/ingest/index.ts";
import { buildNormalizedCards } from "../src/content/build.ts";
import { splitChronological } from "../src/fsrs/index.ts";

const DIR = "./data/candy";
const SESSION_GAP_MS = 30 * 60 * 1000;

const files = (await readdir(DIR)).filter((f) => f.endsWith(".apkg")).sort();
console.log(`arquivos: ${files.join(", ")}`);

for (const file of files) {
  console.log("\n" + "=".repeat(78));
  console.log(file);
  console.log("=".repeat(78));

  const buffer = await readFile(`${DIR}/${file}`);
  const { db, cleanup } = await openApkgDatabase(buffer);
  let deckPathById: Map<number, string[]>;
  let didByCardId: Map<number, number>;
  let deckDescriptions: { id: number; name: string; desc: string }[] = [];
  try {
    const hasDecksTable = (db.prepare(`select name from sqlite_master where type='table' and name='decks'`).get()) !== undefined;
    if (hasDecksTable) {
      const deckRows = db.prepare(`select id, name from decks`).all() as { id: number; name: string }[];
      deckPathById = new Map(deckRows.map((d) => [d.id, d.name.split("\x1f")]));
    } else {
      // Legacy schema: decks live as a JSON blob in col.decks, name path
      // separated by "::" (not \x1f as in the normalized schema).
      const colRow = db.prepare(`select decks from col`).get() as { decks: string };
      const parsed = JSON.parse(colRow.decks) as Record<string, { id?: number; name: string; desc?: string }>;
      deckPathById = new Map();
      for (const [key, d] of Object.entries(parsed)) {
        const id = d.id ?? Number(key);
        deckPathById.set(id, d.name.split("::"));
        deckDescriptions.push({ id, name: d.name, desc: d.desc ?? "" });
      }
    }
    const cardRows = db.prepare(`select id, did from cards`).all() as { id: number; did: number }[];
    didByCardId = new Map(cardRows.map((r) => [r.id, r.did]));
  } finally {
    db.close();
    cleanup();
  }

  if (deckDescriptions.length > 0) {
    console.log(`\ndescrições dos baralhos (schema legado):`);
    for (const d of deckDescriptions) {
      if (d.desc.trim()) console.log(`  "${d.name}": ${d.desc}`);
    }
  }

  const { collection, reviews } = await ingestApkgFile(`${DIR}/${file}`);

  // 1. Revlog não vazio?
  console.log(`\n1. Revlog não vazio: ${collection.revlog.length > 0 ? "SIM" : "NÃO"} (${collection.revlog.length} entradas brutas)`);

  // 2. Cartões, cartões estudados, período coberto, resets reais.
  const studiedCardIds = new Set(collection.revlog.map((e) => e.cardId));
  const rawIds = collection.revlog.map((r) => r.id);
  const periodStart = rawIds.length > 0 ? Math.min(...rawIds) : null;
  const periodEnd = rawIds.length > 0 ? Math.max(...rawIds) : null;
  const realResets = collection.revlog.filter((e) => e.type === 4 && e.factor === 0);
  const realResetCards = new Set(realResets.map((e) => e.cardId));
  console.log(`\n2. Cartões: ${collection.cards.length}`);
  console.log(`   Cartões estudados (>=1 entrada em revlog bruto): ${studiedCardIds.size}`);
  console.log(`   Período coberto (revlog bruto): ${periodStart ? new Date(periodStart).toISOString().slice(0, 10) : "n/a"} a ${periodEnd ? new Date(periodEnd).toISOString().slice(0, 10) : "n/a"}`);
  console.log(`   Resets reais (type=4 AND factor=0): ${realResets.length} entradas, ${realResetCards.size} cartões afetados`);

  // 3. Revisões espaçadas (>=1 dia) e falhas, total e no teste (30%).
  const byCard = new Map<number, typeof reviews>();
  for (const r of reviews) { const arr = byCard.get(r.cardId); if (arr) arr.push(r); else byCard.set(r.cardId, [r]); }
  const DAY_MS = 86_400_000;
  const spacedAll: typeof reviews = [];
  for (const cardReviews of byCard.values()) {
    const sorted = [...cardReviews].sort((a, b) => a.id - b.id);
    for (let i = 1; i < sorted.length; i++) {
      const gapDays = Math.floor((sorted[i]!.id - sorted[i - 1]!.id) / DAY_MS);
      if (gapDays >= 1) spacedAll.push(sorted[i]!);
    }
  }
  const failuresAll = spacedAll.filter((r) => r.rating === 1).length;

  const { test } = splitChronological(reviews, 0.7);
  const testIds = new Set(test.map((r) => r.id));
  const spacedTest = spacedAll.filter((r) => testIds.has(r.id));
  const failuresTest = spacedTest.filter((r) => r.rating === 1).length;

  console.log(`\n3. Revisões mantidas (pós-filtro): ${reviews.length}`);
  console.log(`   Revisões espaçadas (>=1 dia), total: ${spacedAll.length}, falhas: ${failuresAll}`);
  console.log(`   Revisões espaçadas (>=1 dia), no teste (30%): ${spacedTest.length}, falhas: ${failuresTest}`);

  // 4. Subbaralhos: quantos e % de cartões estudados com subbaralho.
  const normalized = buildNormalizedCards(collection);
  const reviewedCardIds = new Set(reviews.map((r) => r.cardId));
  const eligible = normalized.filter((c) => !c.contentless && reviewedCardIds.has(c.cardId));
  let withSubdeck = 0;
  const distinctSubdecks = new Set<string>();
  for (const c of eligible) {
    const did = didByCardId.get(c.cardId);
    const path = did !== undefined ? deckPathById.get(did) : undefined;
    if (path && path.length > 1) {
      withSubdeck++;
      distinctSubdecks.add(path.join(" > "));
    }
  }
  console.log(`\n4. Cartões elegíveis (com conteúdo e estudados): ${eligible.length}`);
  console.log(`   Subbaralhos distintos: ${distinctSubdecks.size}`);
  console.log(`   Cartões com subbaralho real: ${withSubdeck}/${eligible.length} (${((withSubdeck / eligible.length) * 100).toFixed(1)}%)`);

  // 5. Sessões detectadas.
  const sortedAll = [...reviews].sort((a, b) => a.id - b.id);
  let sessionCounter = -1;
  let lastTimestamp: number | null = null;
  for (const r of sortedAll) {
    if (lastTimestamp === null || r.id - lastTimestamp >= SESSION_GAP_MS) sessionCounter++;
    lastTimestamp = r.id;
  }
  console.log(`\n5. Sessões detectadas (gap <30min): ${sessionCounter + 1}`);
}
