import { readdir } from "node:fs/promises";
import { ingestApkgFile } from "../src/ingest/index.ts";
import { buildNormalizedCards } from "../src/content/build.ts";
import type { RawRevlogEntry, Review } from "../src/ingest/types.ts";

const DAY_MS = 86_400_000;
const DIR = "./data/misael";

// "Esta semana" relative to today (2026-09-25): the last 7 days.
const NOW = Date.now();
const WEEK_AGO = NOW - 7 * DAY_MS;
const YEAR_2022_END = Date.UTC(2022, 11, 31, 23, 59, 59);

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

interface ManualEntryCheck {
  entry: RawRevlogEntry;
  hasHistoryFrom2022: boolean; // raw revlog for this card has an entry with id <= end of 2022
  earliestRawDate: string | null;
  preservedInFilteredHistory: boolean; // filtered reviews for this card still include a 2022 entry
}

interface DeckStats {
  file: string;
  totalRevlog: number;
  manualThisWeek: ManualEntryCheck[];
  totalCards: number;
  studiedCards: number;
  keptReviews: Review[];
  spacedReviews: Review[]; // elapsedDays >= 1 since previous kept review of same card
  failuresAll: number;
  failuresSpaced: number;
  periodStart: number | null;
  periodEnd: number | null;
  rawPeriodStart: number | null;
  rawPeriodEnd: number | null;
  realResets: RawRevlogEntry[];
  realResetCards: Set<number>;
  contentlessCards: number;
}

async function inspectDeck(file: string): Promise<DeckStats> {
  const path = `${DIR}/${file}`;
  const { collection, reviews } = await ingestApkgFile(path);

  const totalRevlog = collection.revlog.length;

  const rawByCard = new Map<number, RawRevlogEntry[]>();
  for (const e of collection.revlog) {
    const arr = rawByCard.get(e.cardId);
    if (arr) arr.push(e);
    else rawByCard.set(e.cardId, [e]);
  }
  const filteredByCard = new Map<number, Review[]>();
  for (const r of reviews) {
    const arr = filteredByCard.get(r.cardId);
    if (arr) arr.push(r);
    else filteredByCard.set(r.cardId, [r]);
  }

  const manualThisWeek: ManualEntryCheck[] = collection.revlog
    .filter((e) => e.type === 4 && e.id >= WEEK_AGO)
    .map((entry) => {
      const cardRaw = rawByCard.get(entry.cardId) ?? [];
      const earliestRaw = cardRaw.length > 0 ? Math.min(...cardRaw.map((r) => r.id)) : null;
      const hasHistoryFrom2022 = cardRaw.some((r) => r.id <= YEAR_2022_END);
      const cardFiltered = filteredByCard.get(entry.cardId) ?? [];
      const preservedInFilteredHistory = cardFiltered.some((r) => r.id <= YEAR_2022_END);
      return {
        entry,
        hasHistoryFrom2022,
        earliestRawDate: earliestRaw !== null ? fmtDate(earliestRaw) : null,
        preservedInFilteredHistory,
      };
    });

  const totalCards = collection.cards.length;
  const studiedCardIds = new Set(collection.revlog.map((e) => e.cardId));
  const studiedCards = studiedCardIds.size;

  // Spaced reviews (>=1 day since the card's previous KEPT review) — plain
  // timestamp arithmetic, no FSRS/model involved (per "não rode modelos").
  const spacedReviews: Review[] = [];
  for (const cardReviews of filteredByCard.values()) {
    const sorted = [...cardReviews].sort((a, b) => a.id - b.id);
    for (let i = 1; i < sorted.length; i++) {
      const elapsedDays = Math.floor((sorted[i]!.id - sorted[i - 1]!.id) / DAY_MS);
      if (elapsedDays >= 1) spacedReviews.push(sorted[i]!);
    }
  }

  const failuresAll = reviews.filter((r) => r.rating === 1).length;
  const failuresSpaced = spacedReviews.filter((r) => r.rating === 1).length;

  const keptIds = reviews.map((r) => r.id);
  const periodStart = keptIds.length > 0 ? Math.min(...keptIds) : null;
  const periodEnd = keptIds.length > 0 ? Math.max(...keptIds) : null;

  const rawIds = collection.revlog.map((r) => r.id);
  const rawPeriodStart = rawIds.length > 0 ? Math.min(...rawIds) : null;
  const rawPeriodEnd = rawIds.length > 0 ? Math.max(...rawIds) : null;

  const realResets = collection.revlog.filter((e) => e.type === 4 && e.factor === 0);
  const realResetCards = new Set(realResets.map((e) => e.cardId));

  const normalized = buildNormalizedCards(collection);
  const contentlessCards = normalized.filter((c) => c.contentless).length;

  return {
    file,
    totalRevlog,
    manualThisWeek,
    totalCards,
    studiedCards,
    keptReviews: reviews,
    spacedReviews,
    failuresAll,
    failuresSpaced,
    periodStart,
    periodEnd,
    rawPeriodStart,
    rawPeriodEnd,
    realResets,
    realResetCards,
    contentlessCards,
  };
}

const files = (await readdir(DIR)).filter((f) => f.endsWith(".apkg")).sort();
console.log(`Baralhos encontrados: ${files.length}\n`);

const allStats: DeckStats[] = [];

for (const file of files) {
  const s = await inspectDeck(file);
  allStats.push(s);

  console.log("=".repeat(78));
  console.log(file);
  console.log("=".repeat(78));

  console.log(`1. Revlog não vazio: ${s.totalRevlog > 0 ? "SIM" : "NÃO"} (${s.totalRevlog} entradas brutas)`);

  console.log(`\n2. Entradas "definir data de vencimento" (type=4) nos últimos 7 dias: ${s.manualThisWeek.length}`);
  for (const m of s.manualThisWeek) {
    const wiped = m.hasHistoryFrom2022 && !m.preservedInFilteredHistory;
    console.log(
      `   cartão=${m.entry.cardId} data=${fmtDate(m.entry.id)} ease=${m.entry.ease} factor=${m.entry.factor} ` +
      `| histórico bruto desde 2022? ${m.hasHistoryFrom2022 ? "sim" : "não"} (1ª entrada bruta: ${m.earliestRawDate ?? "n/a"}) ` +
      `| preservado após filtro? ${m.preservedInFilteredHistory ? "SIM" : "NÃO"}${wiped ? "  <<< HISTÓRICO APAGADO PELO RESET" : ""}`,
    );
  }
  if (s.manualThisWeek.length === 0) console.log("   (nenhuma)");

  console.log(`\n3. Cartões: ${s.totalCards}`);
  console.log(`   Cartões estudados (>=1 entrada em revlog bruto): ${s.studiedCards}`);
  console.log(`   Revisões mantidas após filtro: ${s.keptReviews.length}`);
  console.log(`   Revisões espaçadas (>=1 dia desde a revisão mantida anterior do mesmo cartão): ${s.spacedReviews.length}`);
  console.log(`   Falhas (Again) entre todas as revisões mantidas: ${s.failuresAll}`);
  console.log(`   Falhas (Again) entre as revisões espaçadas: ${s.failuresSpaced}`);
  console.log(`   Período coberto (revisões mantidas): ${s.periodStart ? fmtDate(s.periodStart) : "n/a"} a ${s.periodEnd ? fmtDate(s.periodEnd) : "n/a"}`);
  console.log(`   Período coberto (revlog bruto, sem filtro): ${s.rawPeriodStart ? fmtDate(s.rawPeriodStart) : "n/a"} a ${s.rawPeriodEnd ? fmtDate(s.rawPeriodEnd) : "n/a"}`);
  console.log(`   Resets reais (type=4 AND factor=0): ${s.realResets.length} entradas, ${s.realResetCards.size} cartões afetados`);

  console.log(`\n4. Cartões sem texto útil (contentless): ${s.contentlessCards} / ${s.totalCards} (${((s.contentlessCards / s.totalCards) * 100).toFixed(1)}%)`);

  console.log();
}

console.log("=".repeat(78));
console.log("TOTAIS (soma dos 3 baralhos)");
console.log("=".repeat(78));
const sum = (f: (s: DeckStats) => number) => allStats.reduce((acc, s) => acc + f(s), 0);
console.log(`Revlog bruto total: ${sum((s) => s.totalRevlog)}`);
console.log(`Entradas "definir data de vencimento" nos últimos 7 dias: ${sum((s) => s.manualThisWeek.length)}`);
console.log(`Cartões totais: ${sum((s) => s.totalCards)}`);
console.log(`Cartões estudados: ${sum((s) => s.studiedCards)}`);
console.log(`Revisões mantidas: ${sum((s) => s.keptReviews.length)}`);
console.log(`Revisões espaçadas (>=1 dia): ${sum((s) => s.spacedReviews.length)}`);
console.log(`Falhas (todas as mantidas): ${sum((s) => s.failuresAll)}`);
console.log(`Falhas (espaçadas): ${sum((s) => s.failuresSpaced)}`);
console.log(`Resets reais (entradas): ${sum((s) => s.realResets.length)}`);
console.log(`Resets reais (cartões distintos, somando por baralho): ${sum((s) => s.realResetCards.size)}`);
const totalContentless = sum((s) => s.contentlessCards);
const totalCardsAll = sum((s) => s.totalCards);
console.log(`Cartões sem texto útil: ${totalContentless} / ${totalCardsAll} (${((totalContentless / totalCardsAll) * 100).toFixed(1)}%)`);
