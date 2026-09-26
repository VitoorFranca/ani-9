// MISAEL_SESSION_PROTOCOL.md, including the same-deck supplementary cut
// amendment. Computes counts for both cuts, then residuals/effects/
// bootstrap-by-session for both. No API calls (reads cached classification).
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
// Ingest (same as analyze-misael-concepts.mts).
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
// FSRS + base (FSRS+deck) model, replayed continuously over ALL reviews, to
// get includedInEval (B-is-spaced) and a prediction p for every review
// (using only history strictly before it -- the online replay convention
// already used throughout this project).
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
console.log(`base (FSRS+deck) grid: ${JSON.stringify(deckGridBest)} trainLogLoss=${deckGridBestLoss.toFixed(4)}`);

// Prediction p for EVERY review (not just test-period), continuous online replay.
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
const totalSessions = sessionCounter + 1;
console.log(`sessões detectadas (gap < 30min, todas as revisões): ${totalSessions}`);

const eligibleBySession = new Map<number, SessionedReview[]>();
for (const sr of sessioned) {
  if (!allCards.has(sr.review.cardId)) continue;
  const arr = eligibleBySession.get(sr.sessionId);
  if (arr) arr.push(sr);
  else eligibleBySession.set(sr.sessionId, [sr]);
}
const sessionsWithEligiblePairs = [...eligibleBySession.values()].filter((arr) => arr.length >= 2).length;
console.log(`sessões com >=2 revisões elegíveis (candidatas a par): ${sessionsWithEligiblePairs}`);

function isRelated(cardA: number, cardB: number): boolean {
  if (topicByCard.get(cardA) === topicByCard.get(cardB)) return true;
  const conceptsA = listConceptsByCard.get(cardA) ?? [];
  const conceptsB = new Set(listConceptsByCard.get(cardB) ?? []);
  return conceptsA.some((c) => conceptsB.has(c));
}

// ---------------------------------------------------------------------------
// Pairs: related (shared by both cuts), unrelated-any (principal),
// unrelated-same-deck (supplementary).
// ---------------------------------------------------------------------------

interface Pair { sessionId: number; bReviewId: number; aCorrect: boolean }
const relatedPairs: Pair[] = [];
const unrelatedAnyPairs: Pair[] = [];
const unrelatedSameDeckPairs: Pair[] = [];
let bCandidates = 0;
let bSpacedCandidates = 0;

for (const [sid, group] of eligibleBySession) {
  for (let i = 0; i < group.length; i++) {
    const b = group[i]!.review;
    bCandidates++;
    if (!includedInEvalByReviewId.get(b.id)) continue;
    bSpacedCandidates++;

    let bestRelated: Review | null = null;
    let bestUnrelatedAny: Review | null = null;
    let bestUnrelatedSameDeck: Review | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const a = group[j]!.review;
      if (b.id - a.id > PAIR_WINDOW_MS) break;
      if (a.cardId === b.cardId) continue;
      if (isRelated(a.cardId, b.cardId)) {
        if (bestRelated === null || a.id > bestRelated.id) bestRelated = a;
      } else {
        if (bestUnrelatedAny === null || a.id > bestUnrelatedAny.id) bestUnrelatedAny = a;
        if (deckByCard.get(a.cardId) === deckByCard.get(b.cardId)) {
          if (bestUnrelatedSameDeck === null || a.id > bestUnrelatedSameDeck.id) bestUnrelatedSameDeck = a;
        }
      }
    }

    if (bestRelated) relatedPairs.push({ sessionId: sid, bReviewId: b.id, aCorrect: bestRelated.rating !== 1 });
    if (bestUnrelatedAny) unrelatedAnyPairs.push({ sessionId: sid, bReviewId: b.id, aCorrect: bestUnrelatedAny.rating !== 1 });
    if (bestUnrelatedSameDeck) unrelatedSameDeckPairs.push({ sessionId: sid, bReviewId: b.id, aCorrect: bestUnrelatedSameDeck.rating !== 1 });
  }
}

function reportCounts(label: string, related: Pair[], unrelated: Pair[]) {
  const relCorrect = related.filter((p) => p.aCorrect).length;
  const relWrong = related.filter((p) => !p.aCorrect).length;
  const unrelCorrect = unrelated.filter((p) => p.aCorrect).length;
  const unrelWrong = unrelated.filter((p) => !p.aCorrect).length;
  console.log(`\n--- ${label} ---`);
  console.log(`  pares totais: ${related.length + unrelated.length}`);
  console.log(`  relacionados, A certo:      ${relCorrect}`);
  console.log(`  relacionados, A errado:     ${relWrong}`);
  console.log(`  não relacionados, A certo:  ${unrelCorrect}`);
  console.log(`  não relacionados, A errado: ${unrelWrong}`);
}

console.log(`\ncandidatos a B (elegíveis, sessão com >=2 elegíveis): ${bCandidates}`);
console.log(`candidatos a B espaçados (includedInEval): ${bSpacedCandidates}`);
reportCounts("Recorte PRINCIPAL (não relacionados = qualquer baralho)", relatedPairs, unrelatedAnyPairs);
reportCounts("Recorte SUPLEMENTAR (não relacionados = mesmo baralho)", relatedPairs, unrelatedSameDeckPairs);

// ---------------------------------------------------------------------------
// Residuals, effects, bootstrap by session.
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

function bootstrapConceptEffectBySession(related: Pair[], unrelated: Pair[]): { mean: number; ci95: [number, number] } {
  const relatedBySession = new Map<number, Pair[]>();
  for (const p of related) { const arr = relatedBySession.get(p.sessionId); if (arr) arr.push(p); else relatedBySession.set(p.sessionId, [p]); }
  const unrelatedBySession = new Map<number, Pair[]>();
  for (const p of unrelated) { const arr = unrelatedBySession.get(p.sessionId); if (arr) arr.push(p); else unrelatedBySession.set(p.sessionId, [p]); }
  const sessions = [...new Set([...relatedBySession.keys(), ...unrelatedBySession.keys()])];

  const random = mulberry32(BOOTSTRAP_SEED);
  const deltas: number[] = [];
  for (let iter = 0; iter < BOOTSTRAP_ITERATIONS; iter++) {
    const sampledRelated: Pair[] = [];
    const sampledUnrelated: Pair[] = [];
    for (let k = 0; k < sessions.length; k++) {
      const sid = sessions[Math.floor(random() * sessions.length)]!;
      sampledRelated.push(...(relatedBySession.get(sid) ?? []));
      sampledUnrelated.push(...(unrelatedBySession.get(sid) ?? []));
    }
    deltas.push(conceptEffect(sampledRelated, sampledUnrelated));
  }
  deltas.sort((a, b) => a - b);
  const lo = deltas[Math.floor(0.025 * deltas.length)]!;
  const hi = deltas[Math.min(deltas.length - 1, Math.floor(0.975 * deltas.length))]!;
  const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length;
  return { mean, ci95: [lo, hi] };
}

console.log(`\n${"=".repeat(78)}\nResíduos, efeitos e bootstrap por sessão\n${"=".repeat(78)}`);

for (const [label, unrelated] of [
  ["PRINCIPAL (não relacionados = qualquer baralho)", unrelatedAnyPairs],
  ["SUPLEMENTAR (não relacionados = mesmo baralho)", unrelatedSameDeckPairs],
] as const) {
  console.log(`\n--- ${label} ---`);
  const effRelated = effect(relatedPairs);
  const effUnrelated = effect(unrelated);
  const concept = conceptEffect(relatedPairs, unrelated);
  console.log(`efeito(relacionados) = ${effRelated.toFixed(4)}`);
  console.log(`efeito(não relacionados) = ${effUnrelated.toFixed(4)}`);
  console.log(`efeito de conceito = ${concept.toFixed(4)}`);
  const boot = bootstrapConceptEffectBySession(relatedPairs, unrelated);
  console.log(`bootstrap por sessão (${BOOTSTRAP_ITERATIONS}x): média=${boot.mean.toFixed(4)} CI95=[${boot.ci95[0].toFixed(4)}, ${boot.ci95[1].toFixed(4)}]`);
  const success = concept < 0 && boot.ci95[1] < 0;
  console.log(`sucesso (efeito negativo, IC inteiramente abaixo de zero)? ${success}`);
}
