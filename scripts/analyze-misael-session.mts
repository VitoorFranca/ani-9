// MISAEL_SESSION_PROTOCOL.md. This run computes ONLY the counts (sessions,
// pairs per group) and stops -- no residual/effect/bootstrap yet. No API
// calls (reads the cached classification).
import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { ingestApkgFile, openApkgDatabase } from "../src/ingest/index.ts";
import { buildNormalizedCards } from "../src/content/build.ts";
import { replayAll } from "../src/fsrs/index.ts";
import { FSRSAlgorithm, generatorParameters } from "ts-fsrs";
import { splitChronological, optimizeParameters } from "../src/fsrs/index.ts";
import type { Review } from "../src/ingest/types.ts";
import type { NormalizedCard } from "../src/content/types.ts";

const DIR = "./data/misael";
const CACHE_DIR = "./cache";
const SESSION_GAP_MS = 30 * 60 * 1000;
const PAIR_WINDOW_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Ingest (same as analyze-misael-concepts.mts): pooled reviews, eligible
// cards, deck/topic labels, cached list-concept classification.
// ---------------------------------------------------------------------------

const files = (await readdir(DIR)).filter((f) => f.endsWith(".apkg")).sort();
const allReviews: Review[] = [];
const allCards = new Map<number, NormalizedCard>();
const deckByCard = new Map<number, string>();
const topicByCard = new Map<number, string>();

for (const file of files) {
  const buffer = await readFile(`${DIR}/${file}`);
  const { db, cleanup } = await openApkgDatabase(buffer);
  let deckPathById: Map<number, string[]>;
  let didByCardId: Map<number, number>;
  try {
    const deckRows = db.prepare(`select id, name from decks`).all() as { id: number; name: string }[];
    deckPathById = new Map(deckRows.map((d) => [d.id, d.name.split("\x1f")]));
    const cardRows = db.prepare(`select id, did from cards`).all() as { id: number; did: number }[];
    didByCardId = new Map(cardRows.map((r) => [r.id, r.did]));
  } finally {
    db.close();
    cleanup();
  }
  const { collection, reviews } = await ingestApkgFile(`${DIR}/${file}`);
  const normalized = buildNormalizedCards(collection);
  const reviewedCardIds = new Set(reviews.map((r) => r.cardId));
  for (const c of normalized) {
    if (c.contentless || !reviewedCardIds.has(c.cardId)) continue;
    allCards.set(c.cardId, c);
    deckByCard.set(c.cardId, file);
    const did = didByCardId.get(c.cardId);
    const path = did !== undefined ? deckPathById.get(did) : undefined;
    topicByCard.set(c.cardId, path && path.length > 1 ? path.join(" > ") : `deck:${file}`);
  }
  allReviews.push(...reviews);
}
console.log(`cartões elegíveis (pooled): ${allCards.size}`);
console.log(`revisões totais (pooled, todos os cartões): ${allReviews.length}`);

const listConceptsByCard = new Map<number, string[]>(
  JSON.parse(readFileSync(`${CACHE_DIR}/misael-classify-all.json`, "utf8")) as [number, string[]][],
);

// ---------------------------------------------------------------------------
// "B é espaçada" (includedInEval) via o replay padrão (mesmo FSRS otimizado
// do resto do protocolo -- só precisamos do flag includedInEval aqui, não
// da previsão da base ainda).
// ---------------------------------------------------------------------------

const { train } = splitChronological(allReviews);
const opt = await optimizeParameters(train);
const fsrsAlgo = new FSRSAlgorithm(generatorParameters({ w: opt.optimizedParameters ?? opt.defaultParameters }));
const replayed = replayAll(fsrsAlgo, allReviews);
const includedInEvalByReviewId = new Map(replayed.map((r) => [r.reviewId, r.includedInEval]));

// ---------------------------------------------------------------------------
// Sessions: over the FULL pooled review stream (all cards, including
// contentless -- so a real continuous study session isn't artificially
// split by excluding a contentless-card review in the middle of it).
// ---------------------------------------------------------------------------

const sortedAll = [...allReviews].sort((a, b) => a.id - b.id);
interface SessionedReview { review: Review; sessionId: number }
const sessioned: SessionedReview[] = [];
let sessionId = -1;
let lastTimestamp: number | null = null;
for (const r of sortedAll) {
  if (lastTimestamp === null || r.id - lastTimestamp >= SESSION_GAP_MS) sessionId++;
  sessioned.push({ review: r, sessionId });
  lastTimestamp = r.id;
}
const totalSessions = sessionId + 1;
console.log(`sessões detectadas (gap < 30min, todas as revisões): ${totalSessions}`);

// Eligible-only view, grouped by session, in chronological order.
const eligibleBySession = new Map<number, SessionedReview[]>();
for (const sr of sessioned) {
  if (!allCards.has(sr.review.cardId)) continue;
  const arr = eligibleBySession.get(sr.sessionId);
  if (arr) arr.push(sr);
  else eligibleBySession.set(sr.sessionId, [sr]);
}
const sessionsWithEligiblePairs = [...eligibleBySession.values()].filter((arr) => arr.length >= 2).length;
console.log(`sessões com >=2 revisões elegíveis (candidatas a par): ${sessionsWithEligiblePairs}`);

// ---------------------------------------------------------------------------
// Relatedness.
// ---------------------------------------------------------------------------

function isRelated(cardA: number, cardB: number): boolean {
  if (topicByCard.get(cardA) === topicByCard.get(cardB)) return true;
  const conceptsA = listConceptsByCard.get(cardA) ?? [];
  const conceptsB = new Set(listConceptsByCard.get(cardB) ?? []);
  return conceptsA.some((c) => conceptsB.has(c));
}

// ---------------------------------------------------------------------------
// Pairs: for each eligible, spaced B, find the most recent related A and
// the most recent unrelated A within the same session and <=2h before B,
// with a different cardId.
// ---------------------------------------------------------------------------

interface PairCount { relatedCorrect: number; relatedWrong: number; unrelatedCorrect: number; unrelatedWrong: number }
const counts: PairCount = { relatedCorrect: 0, relatedWrong: 0, unrelatedCorrect: 0, unrelatedWrong: 0 };
let totalPairs = 0;
let bCandidates = 0;
let bSpacedCandidates = 0;

for (const group of eligibleBySession.values()) {
  for (let i = 0; i < group.length; i++) {
    const b = group[i]!.review;
    bCandidates++;
    if (!includedInEvalByReviewId.get(b.id)) continue;
    bSpacedCandidates++;

    let bestRelated: Review | null = null;
    let bestUnrelated: Review | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const a = group[j]!.review;
      if (b.id - a.id > PAIR_WINDOW_MS) break; // chronological, only gets further away
      if (a.cardId === b.cardId) continue;
      if (isRelated(a.cardId, b.cardId)) {
        if (bestRelated === null || a.id > bestRelated.id) bestRelated = a;
      } else {
        if (bestUnrelated === null || a.id > bestUnrelated.id) bestUnrelated = a;
      }
    }

    if (bestRelated) {
      totalPairs++;
      if (bestRelated.rating === 1) counts.relatedWrong++;
      else counts.relatedCorrect++;
    }
    if (bestUnrelated) {
      totalPairs++;
      if (bestUnrelated.rating === 1) counts.unrelatedWrong++;
      else counts.unrelatedCorrect++;
    }
  }
}

console.log(`\ncandidatos a B (elegíveis, qualquer sessão com >=2 elegíveis): ${bCandidates}`);
console.log(`candidatos a B que são espaçados (includedInEval): ${bSpacedCandidates}`);
console.log(`\npares totais formados: ${totalPairs}`);
console.log(`  relacionados, A certo:      ${counts.relatedCorrect}`);
console.log(`  relacionados, A errado:     ${counts.relatedWrong}`);
console.log(`  não relacionados, A certo:  ${counts.unrelatedCorrect}`);
console.log(`  não relacionados, A errado: ${counts.unrelatedWrong}`);
