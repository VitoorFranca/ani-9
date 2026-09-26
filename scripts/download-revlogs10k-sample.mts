// REVLOGS10K_PROTOCOL.md. Downloads 200 users (fixed seed), one at a time,
// in foreground, freeing memory between users. Reports ONLY counts -- no
// Delta/effect calculation (that needs FSRS + the frozen model, a later step).
import { parquetReadObjects } from "hyparquet";
import { splitChronological } from "../src/fsrs/index.ts";
import type { Review } from "../src/ingest/types.ts";

const REPO = "open-spaced-repetition/anki-revlogs-10k";
const SAMPLE_SIZE = Number(process.env["REVLOGS10K_SAMPLE"] ?? 200);
const SEED = 42;
const TOTAL_USERS = 10000;
const DAY_MS = 86_400_000;
const MIN_SPACED_FAILURES_PER_USER = 30;
const MIN_AGGREGATE_SPACED_FAILURES = 150;

const hfToken = process.env["HF_TOKEN"];
if (!hfToken) throw new Error("HF_TOKEN não encontrado no ambiente (.env)");

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => { state |= 0; state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [arr[i], arr[j]] = [arr[j]!, arr[i]!]; }
  return arr;
}

const allUserIds = Array.from({ length: TOTAL_USERS }, (_, i) => i + 1);
const sampleUserIds = seededShuffle(allUserIds, SEED).slice(0, SAMPLE_SIZE);
console.log(`amostra: ${sampleUserIds.length} usuários (semente=${SEED}), de ${TOTAL_USERS} totais`);

async function downloadParquetRows(config: "revlogs" | "cards" | "decks", userId: number): Promise<any[]> {
  const url = `https://huggingface.co/datasets/${REPO}/resolve/main/${config}/user_id=${userId}/data.parquet`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${hfToken}` } });
  if (!res.ok) throw new Error(`falha ao baixar ${config}/user_id=${userId}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return (await parquetReadObjects({ file: buf })) as any[];
}

// Root = parent_id null/0/missing from this user's own decks table.
// Depth = steps to root, cycle-protected.
function computeDepths(deckRows: { deck_id: bigint | number; parent_id: bigint | number }[]): Map<string, number> {
  const parentById = new Map<string, string | null>();
  for (const d of deckRows) {
    const id = String(d.deck_id);
    const parent = d.parent_id === null || d.parent_id === undefined || String(d.parent_id) === "0" ? null : String(d.parent_id);
    parentById.set(id, parent);
  }
  const depthCache = new Map<string, number>();
  function depthOf(id: string, visiting: Set<string>): number {
    if (depthCache.has(id)) return depthCache.get(id)!;
    const parent = parentById.get(id) ?? null;
    if (parent === null || !parentById.has(parent) || visiting.has(id)) {
      depthCache.set(id, 0);
      return 0;
    }
    visiting.add(id);
    const d = 1 + depthOf(parent, visiting);
    visiting.delete(id);
    depthCache.set(id, d);
    return d;
  }
  for (const id of parentById.keys()) depthOf(id, new Set());
  return depthCache;
}

interface UserResult {
  userId: number;
  hasDepthGe2: boolean;
  spacedFailuresTest: number;
  qualifies: boolean;
  sessions: number;
  cardsWithRealTopic: number;
  cardsTotal: number;
}

const results: UserResult[] = [];

for (let i = 0; i < sampleUserIds.length; i++) {
  const userId = sampleUserIds[i]!;
  try {
    const [revlogRows, cardRows, deckRows] = await Promise.all([
      downloadParquetRows("revlogs", userId),
      downloadParquetRows("cards", userId),
      downloadParquetRows("decks", userId),
    ]);

    const deckIdByCard = new Map<string, string>();
    for (const c of cardRows) deckIdByCard.set(String(c.card_id), String(c.deck_id));

    const depthByDeck = computeDepths(deckRows.map((d) => ({ deck_id: d.deck_id, parent_id: d.parent_id })));
    const parentByDeck = new Map<string, string | null>();
    for (const d of deckRows) {
      const pid = d.parent_id === null || d.parent_id === undefined || String(d.parent_id) === "0" ? null : String(d.parent_id);
      parentByDeck.set(String(d.deck_id), pid);
    }

    let hasDepthGe2 = false;
    let cardsWithRealTopic = 0;
    const cardIds = new Set(deckIdByCard.keys());
    for (const cardId of cardIds) {
      const deckId = deckIdByCard.get(cardId)!;
      const depth = depthByDeck.get(deckId) ?? 0;
      if (depth >= 2) {
        hasDepthGe2 = true;
        cardsWithRealTopic++;
      }
    }

    // Build Review[]: id = day_offset * DAY_MS + row index (the dataset is
    // documented as pre-sorted chronologically, so the row index is a valid
    // monotonic tie-breaker within a day_offset bucket -- day_offset alone
    // would collide for same-day reviews). rating is direct (dataset already
    // uses 1-4). type=0 uniformly: this dataset has no Anki-native revlog
    // type field, same call already made for KARL (a clean, already-
    // processed revlog with no cramming/reset semantics to filter).
    const reviews: Review[] = revlogRows.map((r, index) => ({
      id: Number(r.day_offset) * DAY_MS + index,
      cardId: Number(r.card_id),
      rating: Number(r.rating) as 1 | 2 | 3 | 4,
      type: 0,
    }));

    const sessions = new Set(revlogRows.map((r) => Number(r.day_offset))).size;

    const { test } = splitChronological(reviews, 0.7);
    const testDayOffsets = new Set(test.map((r) => Math.floor(r.id / DAY_MS)));
    let spacedFailuresTest = 0;
    for (let k = 0; k < revlogRows.length; k++) {
      const r = revlogRows[k]!;
      const dayOffset = Number(r.day_offset);
      if (!testDayOffsets.has(dayOffset)) continue;
      if (Number(r.elapsed_days) >= 1 && Number(r.rating) === 1) spacedFailuresTest++;
    }

    const qualifies = hasDepthGe2 && spacedFailuresTest >= MIN_SPACED_FAILURES_PER_USER;
    results.push({
      userId, hasDepthGe2, spacedFailuresTest, qualifies, sessions,
      cardsWithRealTopic, cardsTotal: cardIds.size,
    });

    if ((i + 1) % 20 === 0 || i === sampleUserIds.length - 1) {
      console.log(`  ${i + 1}/${sampleUserIds.length} usuários processados (RSS=${(process.memoryUsage().rss / 1e6).toFixed(0)}MB)`);
    }
  } catch (error) {
    console.log(`  user_id=${userId}: erro (${error instanceof Error ? error.message : String(error)}) — pulado`);
  }
}

// ---------------------------------------------------------------------------
// Report counts only.
// ---------------------------------------------------------------------------

const withDepthGe2 = results.filter((r) => r.hasDepthGe2).length;
const withEnoughFailures = results.filter((r) => r.spacedFailuresTest >= MIN_SPACED_FAILURES_PER_USER).length;
const qualifying = results.filter((r) => r.qualifies);
const aggregateFailures = qualifying.reduce((s, r) => s + r.spacedFailuresTest, 0);
const totalCardsWithTopic = qualifying.reduce((s, r) => s + r.cardsWithRealTopic, 0);
const totalCards = qualifying.reduce((s, r) => s + r.cardsTotal, 0);
const avgSessions = qualifying.length > 0 ? qualifying.reduce((s, r) => s + r.sessions, 0) / qualifying.length : 0;

console.log(`\n${"=".repeat(78)}`);
console.log("Contagens");
console.log("=".repeat(78));
console.log(`usuários processados com sucesso: ${results.length}/${sampleUserIds.length}`);
console.log(`usuários com >=2 níveis de hierarquia: ${withDepthGe2}/${results.length}`);
console.log(`usuários com >=30 falhas espaçadas no teste: ${withEnoughFailures}/${results.length}`);
console.log(`usuários que passam nos DOIS filtros (incluídos): ${qualifying.length}/${results.length}`);
console.log(`\ntotal de falhas espaçadas no teste (só incluídos): ${aggregateFailures} (mínimo exigido: ${MIN_AGGREGATE_SPACED_FAILURES})`);
console.log(`atinge o mínimo agregado? ${aggregateFailures >= MIN_AGGREGATE_SPACED_FAILURES}`);
console.log(`\nsessões (dias distintos) por usuário incluído: média=${avgSessions.toFixed(1)}`);
console.log(`% de cartões com tópico real (profundidade >=2), só incluídos: ${totalCardsWithTopic}/${totalCards} (${totalCards > 0 ? ((totalCardsWithTopic / totalCards) * 100).toFixed(1) : "n/a"}%)`);
