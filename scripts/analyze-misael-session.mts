// MISAEL_SESSION_PROTOCOL.md + verification requests before interpreting the
// positive result: card:note ratio + same-note exclusion, component effects
// with their own CIs, an order-reversal placebo, and a per-deck breakdown.
// The registered success criterion does not change. No API calls.
import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { ingestApkgFile, openApkgDatabase } from "../src/ingest/index.ts";
import { buildNormalizedCards } from "../src/content/build.ts";
import { replayAll, splitChronological, optimizeParameters } from "../src/fsrs/index.ts";
import type { ReplayedReview } from "../src/fsrs/replay.ts";
import { FSRSAlgorithm, generatorParameters } from "ts-fsrs";
import { GraphBayesianModel, buildCombinedLinks } from "../src/model/index.ts";
import type { Review } from "../src/ingest/types.ts";
import type { NormalizedCard } from "../src/content/types.ts";

const DAY_MS = 86_400_000;
const DIR = "./data/misael";
const CACHE_DIR = "./cache";
const SESSION_GAP_MS = 30 * 60 * 1000;
const PAIR_WINDOW_MS = 2 * 60 * 60 * 1000;
const BOOTSTRAP_ITERATIONS = 3000;
const BOOTSTRAP_SEED = 42;

// ---------------------------------------------------------------------------
// Ingest, plus per-deck card:note ratio (1. verificação).
// ---------------------------------------------------------------------------

const files = (await readdir(DIR)).filter((f) => f.endsWith(".apkg")).sort();
const allReviews: Review[] = [];
const allCards = new Map<number, NormalizedCard>();
const deckByCard = new Map<number, string>();
const topicByCard = new Map<number, string>();

console.log("=".repeat(78));
console.log("1. Razão cartão:nota por baralho");
console.log("=".repeat(78));

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

  const eligibleForDeck = normalized.filter((c) => !c.contentless && reviewedCardIds.has(c.cardId));
  const distinctNotesAll = new Set(collection.cards.map((c) => c.noteId)).size;
  const distinctNotesEligible = new Set(eligibleForDeck.map((c) => c.noteId)).size;
  console.log(
    `${file}: cartões totais=${collection.cards.length} notas totais=${distinctNotesAll} razão=${(collection.cards.length / distinctNotesAll).toFixed(3)}` +
    ` | elegíveis=${eligibleForDeck.length} notas(elegíveis)=${distinctNotesEligible} razão(elegíveis)=${(eligibleForDeck.length / distinctNotesEligible).toFixed(3)}`,
  );

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

const noteIdByCard = new Map<number, number>([...allCards.entries()].map(([cardId, c]) => [cardId, c.noteId]));

const listConceptsByCard = new Map<number, string[]>(
  JSON.parse(readFileSync(`${CACHE_DIR}/misael-classify-all.json`, "utf8")) as [number, string[]][],
);

// ---------------------------------------------------------------------------
// FSRS + base (FSRS+deck) model — same as before, unaffected by same-note
// exclusion (which only affects PAIRING, not the base model itself).
// ---------------------------------------------------------------------------

const { train, test } = splitChronological(allReviews);
const cutoffId = test[0]?.id ?? Infinity;
const opt = await optimizeParameters(train);
const fsrsAlgo = new FSRSAlgorithm(generatorParameters({ w: opt.optimizedParameters ?? opt.defaultParameters }));
const replayed: ReplayedReview[] = replayAll(fsrsAlgo, allReviews);
const includedInEvalByReviewId = new Map(replayed.map((r) => [r.reviewId, r.includedInEval]));

interface EligibleReview { reviewId: number; cardId: number; predictedR: number; label: 0 | 1; day: number; isTrainPeriod: boolean; isTrainEval: boolean }
const eligible: EligibleReview[] = [];
for (const r of replayed) {
  if (r.predictedR === null) continue;
  const isTrainPeriod = r.reviewId < cutoffId;
  eligible.push({
    reviewId: r.reviewId, cardId: r.cardId, predictedR: r.predictedR, label: r.label,
    day: Math.floor(r.reviewId / DAY_MS), isTrainPeriod, isTrainEval: isTrainPeriod && r.includedInEval,
  });
}

const PRIOR_VARIANCE_GRID = [0.25, 1];
const DRIFT_PER_DAY_GRID = [0.001, 0.01];
const LAMBDA_GRID = [0, 0.25, 0.5, 1, 2];
interface ConceptHp { priorVariance: number; driftPerDay: number; lambda: number }
function scoreDeckLogLoss(hp: ConceptHp): number {
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  let sum = 0, count = 0;
  for (const r of eligible) {
    if (!r.isTrainPeriod) break;
    const links = buildCombinedLinks(deckByCard.get(r.cardId), [], { lambdaBase: hp.lambda, lambdaExtra: 0 });
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (r.isTrainEval) {
      const clamped = Math.min(1 - 1e-4, Math.max(1e-4, p));
      sum += r.label === 1 ? -Math.log(clamped) : -Math.log(1 - clamped);
      count++;
    }
  }
  return count > 0 ? sum / count : NaN;
}
let deckGridBest: ConceptHp | null = null, deckGridBestLoss = Infinity;
for (const priorVariance of PRIOR_VARIANCE_GRID) for (const driftPerDay of DRIFT_PER_DAY_GRID) for (const lambda of LAMBDA_GRID) {
  const hp = { priorVariance, driftPerDay, lambda };
  const loss = scoreDeckLogLoss(hp);
  if (loss < deckGridBestLoss) { deckGridBestLoss = loss; deckGridBest = hp; }
}

const baseModel = new GraphBayesianModel<string>({ priorVariance: deckGridBest!.priorVariance, driftPerDay: deckGridBest!.driftPerDay });
const predictionByReviewId = new Map<number, number>();
for (const r of eligible) {
  const links = buildCombinedLinks(deckByCard.get(r.cardId), [], { lambdaBase: deckGridBest!.lambda, lambdaExtra: 0 });
  const p = links.length > 0 ? baseModel.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
  predictionByReviewId.set(r.reviewId, p);
}
const labelByReviewId = new Map(eligible.map((r) => [r.reviewId, r.label]));

// ---------------------------------------------------------------------------
// Sessions.
// ---------------------------------------------------------------------------

const sortedAll = [...allReviews].sort((a, b) => a.id - b.id);
interface SessionedReview { review: Review; sessionId: number }
const sessioned: SessionedReview[] = [];
let sessionCounter = -1;
let lastTimestamp: number | null = null;
for (const r of sortedAll) {
  if (lastTimestamp === null || r.id - lastTimestamp >= SESSION_GAP_MS) sessionCounter++;
  sessioned.push({ review: r, sessionId: sessionCounter });
  lastTimestamp = r.id;
}
const eligibleBySession = new Map<number, SessionedReview[]>();
for (const sr of sessioned) {
  if (!allCards.has(sr.review.cardId)) continue;
  const arr = eligibleBySession.get(sr.sessionId);
  if (arr) arr.push(sr);
  else eligibleBySession.set(sr.sessionId, [sr]);
}

function isRelated(cardA: number, cardB: number): boolean {
  if (topicByCard.get(cardA) === topicByCard.get(cardB)) return true;
  const conceptsA = listConceptsByCard.get(cardA) ?? [];
  const conceptsB = new Set(listConceptsByCard.get(cardB) ?? []);
  return conceptsA.some((c) => conceptsB.has(c));
}

// ---------------------------------------------------------------------------
// Pair construction, generalized: direction "before" (main/placebo-control)
// or "after" (order-reversal placebo, verificação 3); excludeSameNote toggle
// (verificação 1).
// ---------------------------------------------------------------------------

interface Pair { sessionId: number; bReviewId: number; bCardId: number; aCorrect: boolean }

function buildPairs(direction: "before" | "after", excludeSameNote: boolean) {
  const relatedPairs: Pair[] = [];
  const unrelatedAnyPairs: Pair[] = [];
  const unrelatedSameDeckPairs: Pair[] = [];
  let bCandidates = 0;
  let bSpacedCandidates = 0;
  let excludedSameNote = 0;

  for (const [sid, group] of eligibleBySession) {
    for (let i = 0; i < group.length; i++) {
      const b = group[i]!.review;
      bCandidates++;
      if (!includedInEvalByReviewId.get(b.id)) continue;
      bSpacedCandidates++;

      let bestRelated: Review | null = null;
      let bestUnrelatedAny: Review | null = null;
      let bestUnrelatedSameDeck: Review | null = null;

      const scanRange = direction === "before"
        ? Array.from({ length: i }, (_, k) => i - 1 - k) // i-1, i-2, ..., 0
        : Array.from({ length: group.length - i - 1 }, (_, k) => i + 1 + k); // i+1, i+2, ...

      for (const j of scanRange) {
        const a = group[j]!.review;
        const gapMs = direction === "before" ? b.id - a.id : a.id - b.id;
        if (gapMs > PAIR_WINDOW_MS) break; // monotonic in scan order
        if (a.cardId === b.cardId) continue;
        if (excludeSameNote && noteIdByCard.get(a.cardId) === noteIdByCard.get(b.cardId)) {
          excludedSameNote++;
          continue;
        }
        // "most recent"/"closest" candidate: for "before", largest a.id; for "after", smallest a.id.
        const better = (candidate: Review | null) =>
          candidate === null || (direction === "before" ? a.id > candidate.id : a.id < candidate.id);

        if (isRelated(a.cardId, b.cardId)) {
          if (better(bestRelated)) bestRelated = a;
        } else {
          if (better(bestUnrelatedAny)) bestUnrelatedAny = a;
          if (deckByCard.get(a.cardId) === deckByCard.get(b.cardId) && better(bestUnrelatedSameDeck)) {
            bestUnrelatedSameDeck = a;
          }
        }
      }

      if (bestRelated) relatedPairs.push({ sessionId: sid, bReviewId: b.id, bCardId: b.cardId, aCorrect: bestRelated.rating !== 1 });
      if (bestUnrelatedAny) unrelatedAnyPairs.push({ sessionId: sid, bReviewId: b.id, bCardId: b.cardId, aCorrect: bestUnrelatedAny.rating !== 1 });
      if (bestUnrelatedSameDeck) unrelatedSameDeckPairs.push({ sessionId: sid, bReviewId: b.id, bCardId: b.cardId, aCorrect: bestUnrelatedSameDeck.rating !== 1 });
    }
  }

  return { relatedPairs, unrelatedAnyPairs, unrelatedSameDeckPairs, bCandidates, bSpacedCandidates, excludedSameNote };
}

// ---------------------------------------------------------------------------
// Effects, components, bootstrap by session (generalized to bootstrap any
// single statistic computed from resampled related/unrelated pair pools).
// ---------------------------------------------------------------------------

function residualOf(p: Pair): number {
  return labelByReviewId.get(p.bReviewId)! - predictionByReviewId.get(p.bReviewId)!;
}
function meanResidual(pairs: Pair[]): number {
  if (pairs.length === 0) return NaN;
  return pairs.reduce((s, p) => s + residualOf(p), 0) / pairs.length;
}
function effect(group: Pair[]): number {
  const wrong = group.filter((p) => !p.aCorrect);
  const correct = group.filter((p) => p.aCorrect);
  return meanResidual(wrong) - meanResidual(correct);
}
function conceptEffect(related: Pair[], unrelated: Pair[]): number {
  return effect(related) - effect(unrelated);
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => { state |= 0; state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Bootstraps by session an arbitrary statistic of (resampled related pairs,
 * resampled unrelated pairs). `unrelated` may be [] if the statistic
 * ignores it (single-group effect).
 *
 * A resample can land zero pairs in a subgroup (e.g. Direito Administrativo
 * has only 18 "não relacionados, A errado" pairs total, easily missed
 * entirely when resampling whole sessions) -- `effect()` then divides by
 * zero via `meanResidual([])` = NaN. A prior run let these NaNs into the
 * sort, which silently produces an invalid (inverted lo > hi) percentile
 * pair. Fixed here: NaN iterations are discarded before computing
 * percentiles, and the discard count is reported.
 */
function bootstrapBySession(
  related: Pair[],
  unrelated: Pair[],
  statistic: (related: Pair[], unrelated: Pair[]) => number,
): { mean: number; ci95: [number, number]; discarded: number } {
  const relatedBySession = new Map<number, Pair[]>();
  for (const p of related) { const arr = relatedBySession.get(p.sessionId); if (arr) arr.push(p); else relatedBySession.set(p.sessionId, [p]); }
  const unrelatedBySession = new Map<number, Pair[]>();
  for (const p of unrelated) { const arr = unrelatedBySession.get(p.sessionId); if (arr) arr.push(p); else unrelatedBySession.set(p.sessionId, [p]); }
  const sessions = [...new Set([...relatedBySession.keys(), ...unrelatedBySession.keys()])];

  const random = mulberry32(BOOTSTRAP_SEED);
  const rawValues: number[] = [];
  for (let iter = 0; iter < BOOTSTRAP_ITERATIONS; iter++) {
    const sampledRelated: Pair[] = [];
    const sampledUnrelated: Pair[] = [];
    for (let k = 0; k < sessions.length; k++) {
      const sid = sessions[Math.floor(random() * sessions.length)]!;
      sampledRelated.push(...(relatedBySession.get(sid) ?? []));
      sampledUnrelated.push(...(unrelatedBySession.get(sid) ?? []));
    }
    rawValues.push(statistic(sampledRelated, sampledUnrelated));
  }
  const values = rawValues.filter((v) => !Number.isNaN(v));
  const discarded = rawValues.length - values.length;
  values.sort((a, b) => a - b);
  const lo = values[Math.floor(0.025 * values.length)]!;
  const hi = values[Math.min(values.length - 1, Math.floor(0.975 * values.length))]!;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return { mean, ci95: [lo, hi], discarded };
}

function reportCounts(label: string, related: Pair[], unrelated: Pair[]) {
  const relCorrect = related.filter((p) => p.aCorrect).length;
  const relWrong = related.filter((p) => !p.aCorrect).length;
  const unrelCorrect = unrelated.filter((p) => p.aCorrect).length;
  const unrelWrong = unrelated.filter((p) => !p.aCorrect).length;
  console.log(`  ${label}: pares=${related.length + unrelated.length} | rel/certo=${relCorrect} rel/errado=${relWrong} | não-rel/certo=${unrelCorrect} não-rel/errado=${unrelWrong}`);
}

function reportFull(title: string, related: Pair[], unrelated: Pair[]) {
  console.log(`\n--- ${title} ---`);
  reportCounts("contagens", related, unrelated);
  const effRelated = effect(related);
  const effUnrelated = effect(unrelated);
  const concept = conceptEffect(related, unrelated);
  const bootRelated = bootstrapBySession(related, [], (r) => effect(r));
  const bootUnrelated = bootstrapBySession(unrelated, [], (r) => effect(r));
  const bootConcept = bootstrapBySession(related, unrelated, conceptEffect);
  console.log(`  efeito(relacionados)     = ${effRelated.toFixed(4)}  IC95=[${bootRelated.ci95[0].toFixed(4)}, ${bootRelated.ci95[1].toFixed(4)}]${bootRelated.discarded > 0 ? ` (${bootRelated.discarded}/${BOOTSTRAP_ITERATIONS} iterações descartadas por NaN)` : ""}`);
  console.log(`  efeito(não relacionados) = ${effUnrelated.toFixed(4)}  IC95=[${bootUnrelated.ci95[0].toFixed(4)}, ${bootUnrelated.ci95[1].toFixed(4)}]${bootUnrelated.discarded > 0 ? ` (${bootUnrelated.discarded}/${BOOTSTRAP_ITERATIONS} iterações descartadas por NaN)` : ""}`);
  console.log(`  efeito de conceito       = ${concept.toFixed(4)}  IC95=[${bootConcept.ci95[0].toFixed(4)}, ${bootConcept.ci95[1].toFixed(4)}]${bootConcept.discarded > 0 ? ` (${bootConcept.discarded}/${BOOTSTRAP_ITERATIONS} iterações descartadas por NaN)` : ""}`);
  const success = concept < 0 && bootConcept.ci95[1] < 0;
  console.log(`  sucesso (efeito negativo, IC inteiramente abaixo de zero)? ${success}`);
}

// ---------------------------------------------------------------------------
// 1. Refeito excluindo pares A/B da mesma nota.
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(78)}`);
console.log("1 (continuação). Refeito excluindo pares A/B da mesma nota");
console.log("=".repeat(78));

const main = buildPairs("before", true);
console.log(`candidatos a B espaçados: ${main.bSpacedCandidates} (de ${main.bCandidates})`);
console.log(`candidatos A excluídos por serem da mesma nota que B: ${main.excludedSameNote}`);

// ---------------------------------------------------------------------------
// 2. Componentes com IC, nos dois recortes.
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(78)}`);
console.log("2. Componentes com IC (excluindo mesma nota)");
console.log("=".repeat(78));
reportFull("PRINCIPAL (não relacionados = qualquer baralho)", main.relatedPairs, main.unrelatedAnyPairs);
reportFull("SUPLEMENTAR (não relacionados = mesmo baralho)", main.relatedPairs, main.unrelatedSameDeckPairs);

// ---------------------------------------------------------------------------
// 3. Placebo de ordem: A depois de B.
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(78)}`);
console.log("3. Placebo de ordem (A revisado DEPOIS de B, até 2h, mesma sessão)");
console.log("=".repeat(78));

const placebo = buildPairs("after", true);
console.log(`candidatos a B espaçados: ${placebo.bSpacedCandidates}`);
reportFull("PLACEBO — PRINCIPAL", placebo.relatedPairs, placebo.unrelatedAnyPairs);
reportFull("PLACEBO — SUPLEMENTAR", placebo.relatedPairs, placebo.unrelatedSameDeckPairs);

// ---------------------------------------------------------------------------
// 4. Efeito por baralho (recorte principal, excluindo mesma nota).
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(78)}`);
console.log("4. Efeito por baralho (recorte principal, excluindo mesma nota)");
console.log("=".repeat(78));

for (const file of files) {
  const relatedForDeck = main.relatedPairs.filter((p) => deckByCard.get(p.bCardId) === file);
  const unrelatedForDeck = main.unrelatedAnyPairs.filter((p) => deckByCard.get(p.bCardId) === file);
  console.log(`\n${file}`);
  reportFull(`(B neste baralho)`, relatedForDeck, unrelatedForDeck);
}
