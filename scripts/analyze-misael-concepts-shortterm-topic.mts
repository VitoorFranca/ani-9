// EXPLORATORY (see MISAEL_CONCEPTS_PROTOCOL.md, registered after seeing the
// session-contagion placebo failure): a topic node scoped to the session --
// identified as "${sessionId}::${topic}" so it starts fresh every session,
// never carrying state across sessions. No change to GraphBayesianModel.
import { readdir, readFile } from "node:fs/promises";
import { ingestApkgFile, openApkgDatabase } from "../src/ingest/index.ts";
import { buildNormalizedCards } from "../src/content/build.ts";
import { FSRSAlgorithm, generatorParameters } from "ts-fsrs";
import { replayAll, splitChronological, optimizeParameters } from "../src/fsrs/index.ts";
import type { ReplayedReview } from "../src/fsrs/replay.ts";
import { GraphBayesianModel, buildCombinedLinks } from "../src/model/index.ts";
import { logLoss, auc, bootstrapLogLossDeltaByGroup, type ScoredReview } from "../src/eval/index.ts";
import type { Review } from "../src/ingest/types.ts";
import type { NormalizedCard } from "../src/content/types.ts";

const DAY_MS = 86_400_000;
const DIR = "./data/misael";
const SESSION_GAP_MS = 30 * 60 * 1000;
console.time("total");

// ---------------------------------------------------------------------------
// Ingest.
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

// ---------------------------------------------------------------------------
// Sessions (same as MISAEL_SESSION_PROTOCOL.md): <30min gaps, pooled across
// ALL reviews (all cards), so session boundaries reflect true study
// continuity regardless of card content.
// ---------------------------------------------------------------------------

const sortedAll = [...allReviews].sort((a, b) => a.id - b.id);
const sessionIdByReviewId = new Map<number, number>();
let sessionCounter = -1;
let lastTimestamp: number | null = null;
for (const r of sortedAll) {
  if (lastTimestamp === null || r.id - lastTimestamp >= SESSION_GAP_MS) sessionCounter++;
  sessionIdByReviewId.set(r.id, sessionCounter);
  lastTimestamp = r.id;
}
console.log(`sessões detectadas: ${sessionCounter + 1}`);

// ---------------------------------------------------------------------------
// FSRS + eligible table.
// ---------------------------------------------------------------------------

const { train, test } = splitChronological(allReviews);
const cutoffId = test[0]?.id ?? Infinity;
const opt = await optimizeParameters(train);
const fsrsAlgo = new FSRSAlgorithm(generatorParameters({ w: opt.optimizedParameters ?? opt.defaultParameters }));
const replayed: ReplayedReview[] = replayAll(fsrsAlgo, allReviews);

interface EligibleReview {
  reviewId: number; cardId: number; predictedR: number; label: 0 | 1; day: number;
  sessionId: number; isTrainPeriod: boolean; isTrainEval: boolean; isTestEval: boolean;
}
const eligible: EligibleReview[] = [];
for (const r of replayed) {
  if (r.predictedR === null) continue;
  const isTrainPeriod = r.reviewId < cutoffId;
  eligible.push({
    reviewId: r.reviewId, cardId: r.cardId, predictedR: r.predictedR, label: r.label,
    day: Math.floor(r.reviewId / DAY_MS), sessionId: sessionIdByReviewId.get(r.reviewId)!,
    isTrainPeriod, isTrainEval: isTrainPeriod && r.includedInEval, isTestEval: !isTrainPeriod && r.includedInEval,
  });
}

// ---------------------------------------------------------------------------
// Base (FSRS+deck, persistent) — identical construction/hyperparameters as
// the already-registered result.
// ---------------------------------------------------------------------------

const PRIOR_VARIANCE_GRID = [0.25, 1];
const DRIFT_PER_DAY_GRID = [0.001, 0.01];
const LAMBDA_GRID = [0, 0.25, 0.5, 1, 2];
interface ConceptHp { priorVariance: number; driftPerDay: number; lambda: number }
function scoreDeckLogLoss(hp: ConceptHp, trainOnly: boolean): number {
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  let sum = 0, count = 0;
  for (const r of eligible) {
    if (trainOnly && !r.isTrainPeriod) break;
    const included = trainOnly ? r.isTrainEval : r.isTestEval;
    const links = buildCombinedLinks(deckByCard.get(r.cardId), [], { lambdaBase: hp.lambda, lambdaExtra: 0 });
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (included) {
      const clamped = Math.min(1 - 1e-4, Math.max(1e-4, p));
      sum += r.label === 1 ? -Math.log(clamped) : -Math.log(1 - clamped);
      count++;
    }
  }
  return count > 0 ? sum / count : NaN;
}
function evalDeckModel(hp: ConceptHp): ScoredReview[] {
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  const out: ScoredReview[] = [];
  for (const r of eligible) {
    const links = buildCombinedLinks(deckByCard.get(r.cardId), [], { lambdaBase: hp.lambda, lambdaExtra: 0 });
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (r.isTestEval) out.push({ cardId: r.cardId, p, y: r.label });
  }
  return out;
}
let deckGridBest: ConceptHp | null = null, deckGridBestLoss = Infinity;
for (const priorVariance of PRIOR_VARIANCE_GRID) for (const driftPerDay of DRIFT_PER_DAY_GRID) for (const lambda of LAMBDA_GRID) {
  const hp = { priorVariance, driftPerDay, lambda };
  const loss = scoreDeckLogLoss(hp, true);
  if (loss < deckGridBestLoss) { deckGridBestLoss = loss; deckGridBest = hp; }
}
console.log(`base (FSRS+deck) grid: ${JSON.stringify(deckGridBest)} trainLogLoss=${deckGridBestLoss.toFixed(4)}`);
const deckTest = evalDeckModel(deckGridBest!);
console.log(`base (FSRS+deck) teste: n=${deckTest.length} logLoss=${logLoss(deckTest).toFixed(4)} AUC=${auc(deckTest).toFixed(4)}`);

// ---------------------------------------------------------------------------
// Variant: deck (persistent) + session-scoped short-term topic node.
// ---------------------------------------------------------------------------

function shortTermTopicOf(r: EligibleReview): string {
  return `${r.sessionId}::${topicByCard.get(r.cardId)}`;
}

interface CombinedHp { priorVariance: number; driftPerDay: number; lambdaDeck: number; lambdaExtra: number }
function combinedLinksFor(r: EligibleReview, hp: CombinedHp) {
  return buildCombinedLinks(deckByCard.get(r.cardId), [shortTermTopicOf(r)], { lambdaBase: hp.lambdaDeck, lambdaExtra: hp.lambdaExtra });
}
function scoreCombinedLogLoss(hp: CombinedHp, trainOnly: boolean): number {
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  let sum = 0, count = 0;
  for (const r of eligible) {
    if (trainOnly && !r.isTrainPeriod) break;
    const included = trainOnly ? r.isTrainEval : r.isTestEval;
    const links = combinedLinksFor(r, hp);
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (included) {
      const clamped = Math.min(1 - 1e-4, Math.max(1e-4, p));
      sum += r.label === 1 ? -Math.log(clamped) : -Math.log(1 - clamped);
      count++;
    }
  }
  return count > 0 ? sum / count : NaN;
}
function evalCombinedModel(hp: CombinedHp): ScoredReview[] {
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  const out: ScoredReview[] = [];
  for (const r of eligible) {
    const links = combinedLinksFor(r, hp);
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (r.isTestEval) out.push({ cardId: r.cardId, p, y: r.label });
  }
  return out;
}
let combinedBest: CombinedHp | null = null, combinedBestLoss = Infinity;
for (const priorVariance of PRIOR_VARIANCE_GRID) for (const driftPerDay of DRIFT_PER_DAY_GRID) for (const lambdaDeck of LAMBDA_GRID) for (const lambdaExtra of LAMBDA_GRID) {
  const hp = { priorVariance, driftPerDay, lambdaDeck, lambdaExtra };
  const loss = scoreCombinedLogLoss(hp, true);
  if (loss < combinedBestLoss) { combinedBestLoss = loss; combinedBest = hp; }
}
console.log(`\nvariante (deck + tópico de curto prazo) grid: ${JSON.stringify(combinedBest)} trainLogLoss=${combinedBestLoss.toFixed(4)}`);
const combinedTest = evalCombinedModel(combinedBest!);
console.log(`variante teste: n=${combinedTest.length} logLoss=${logLoss(combinedTest).toFixed(4)} AUC=${auc(combinedTest).toFixed(4)}`);

// Equivalence check: lambdaExtra=0 (same priorVariance/driftPerDay/lambdaDeck as the base) must reproduce the base exactly.
const zeroHp: CombinedHp = { priorVariance: deckGridBest!.priorVariance, driftPerDay: deckGridBest!.driftPerDay, lambdaDeck: deckGridBest!.lambda, lambdaExtra: 0 };
const zeroTest = evalCombinedModel(zeroHp);
let maxDiff = 0;
for (let i = 0; i < deckTest.length; i++) maxDiff = Math.max(maxDiff, Math.abs(deckTest[i]!.p - zeroTest[i]!.p));
console.log(`verificação (lambdaExtra=0 vs base): diferença máx=${maxDiff} ${maxDiff < 1e-12 ? "(OK)" : "(FALHOU)"}`);

// ---------------------------------------------------------------------------
// Bootstrap by SESSION (not by card).
// ---------------------------------------------------------------------------

const testSessionIds = eligible.filter((r) => r.isTestEval).map((r) => r.sessionId);
const boot = bootstrapLogLossDeltaByGroup(deckTest, combinedTest, testSessionIds, { iterations: 3000, seed: 42 });
console.log(`\nbootstrap por sessão (3000x) vs base: Δ=${boot.meanDelta.toFixed(4)} CI95=[${boot.ci95[0].toFixed(4)}, ${boot.ci95[1].toFixed(4)}]`);
const favors = boot.ci95[0] > 0;
console.log(`IC inteiramente a favor da variante? ${favors}`);

console.timeEnd("total");
