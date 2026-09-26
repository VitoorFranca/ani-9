// SYNTHETIC_TEST.md. NOT a confirmation of MISAEL_PROSPECTIVE_PROTOCOL.md --
// this deck's review history is synthetic (see every subdeck's description).
// Runs the frozen short-term-topic-node model, with FSRS and the base's
// deck-node hyperparameters refit on this deck's own train split.
import { readFile } from "node:fs/promises";
import { ingestApkgFile, openApkgDatabase } from "../src/ingest/index.ts";
import { buildNormalizedCards } from "../src/content/build.ts";
import { FSRSAlgorithm, generatorParameters } from "ts-fsrs";
import { replayAll, splitChronological, optimizeParameters } from "../src/fsrs/index.ts";
import type { ReplayedReview } from "../src/fsrs/replay.ts";
import { GraphBayesianModel, buildCombinedLinks } from "../src/model/index.ts";
import { logLoss, auc, bootstrapLogLossDeltaByGroup, type ScoredReview } from "../src/eval/index.ts";
import type { NormalizedCard } from "../src/content/types.ts";

const DAY_MS = 86_400_000;
const SESSION_GAP_MS = 30 * 60 * 1000;
const FILE = "./data/candy/0001-GERAL-ANI-9.apkg";

const MAX_RSS_BYTES = 3.5 * 1024 * 1024 * 1024;
let peakRssBytes = 0;
const rssSampler = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 500);
rssSampler.unref();
function checkMemory(where: string): void {
  const rss = process.memoryUsage().rss;
  peakRssBytes = Math.max(peakRssBytes, rss);
  if (rss > MAX_RSS_BYTES) {
    console.error(`ABORTANDO em "${where}": RSS=${(rss / 1e9).toFixed(2)}GB excede o teto`);
    clearInterval(rssSampler);
    process.exit(1);
  }
}

console.time("total");

// ---------------------------------------------------------------------------
// Ingest: single file, legacy schema (col.decks JSON, "::" path separator).
// ---------------------------------------------------------------------------

const buffer = await readFile(FILE);
const { db, cleanup } = await openApkgDatabase(buffer);
let deckPathById: Map<number, string[]>;
let didByCardId: Map<number, number>;
try {
  const colRow = db.prepare(`select decks from col`).get() as { decks: string };
  const parsed = JSON.parse(colRow.decks) as Record<string, { id?: number; name: string }>;
  deckPathById = new Map();
  for (const [key, d] of Object.entries(parsed)) {
    deckPathById.set(d.id ?? Number(key), d.name.split("::"));
  }
  const cardRows = db.prepare(`select id, did from cards`).all() as { id: number; did: number }[];
  didByCardId = new Map(cardRows.map((r) => [r.id, r.did]));
} finally {
  db.close();
  cleanup();
}

const { collection, reviews: allReviews } = await ingestApkgFile(FILE);
const normalized = buildNormalizedCards(collection);
const reviewedCardIds = new Set(allReviews.map((r) => r.cardId));
const allCards = new Map<number, NormalizedCard>();
const deckByCard = new Map<number, string>();
const topicByCard = new Map<number, string>();

for (const c of normalized) {
  if (c.contentless || !reviewedCardIds.has(c.cardId)) continue;
  allCards.set(c.cardId, c);
  const did = didByCardId.get(c.cardId);
  const path = did !== undefined ? deckPathById.get(did) : undefined;
  // See SYNTHETIC_TEST.md: "deck" = 2nd path segment (subject area),
  // "topic" = full path when a 3rd segment exists, else falls back to deck.
  const deckLabel = path && path.length >= 2 ? path[1]! : (path?.[0] ?? "?");
  deckByCard.set(c.cardId, deckLabel);
  topicByCard.set(c.cardId, path && path.length > 2 ? path.join(" > ") : `deck:${deckLabel}`);
}
console.log(`cartões elegíveis: ${allCards.size}, revisões: ${allReviews.length}`);
console.log(`baralhos (áreas) distintos: ${new Set(deckByCard.values()).size}`);

// ---------------------------------------------------------------------------
// Sessions.
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
// FSRS (optimized fresh on this deck) + eligible table.
// ---------------------------------------------------------------------------

const { train, test } = splitChronological(allReviews);
const cutoffId = test[0]?.id ?? Infinity;
const opt = await optimizeParameters(train);
console.log(`FSRS otimização: ${opt.fallbackReason ? `fallback (${opt.fallbackReason})` : "ok"}`);
const fsrsAlgo = new FSRSAlgorithm(generatorParameters({ w: opt.optimizedParameters ?? opt.defaultParameters }));
const replayed: ReplayedReview[] = replayAll(fsrsAlgo, allReviews);
checkMemory("after FSRS replay");

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
console.log(`revisões elegíveis: ${eligible.length}, teste espaçado: ${eligible.filter((r) => r.isTestEval).length}`);

// ---------------------------------------------------------------------------
// Base (FSRS + deck), grid search fresh on this deck's train split.
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
console.log(`\nbase (FSRS+baralho) grid: ${JSON.stringify(deckGridBest)} trainLogLoss=${deckGridBestLoss.toFixed(4)}`);
const deckTest = evalDeckModel(deckGridBest!);
console.log(`base teste: n=${deckTest.length} logLoss=${logLoss(deckTest).toFixed(4)} AUC=${auc(deckTest).toFixed(4)}`);
checkMemory("after base");

// ---------------------------------------------------------------------------
// Variant: FROZEN short-term topic node (priorVariance=1, driftPerDay=0.01,
// lambdaDeck=0, lambdaExtra=2) -- MISAEL_PROSPECTIVE_PROTOCOL.md, not re-fit.
// ---------------------------------------------------------------------------

const FROZEN_HP = { priorVariance: 1, driftPerDay: 0.01, lambdaDeck: 0, lambdaExtra: 2 } as const;

function shortTermTopicOf(r: EligibleReview): string {
  return `${r.sessionId}::${topicByCard.get(r.cardId)}`;
}
function combinedLinksFor(r: EligibleReview, hp: typeof FROZEN_HP) {
  return buildCombinedLinks(deckByCard.get(r.cardId), [shortTermTopicOf(r)], { lambdaBase: hp.lambdaDeck, lambdaExtra: hp.lambdaExtra });
}
function evalCombinedModel(hp: typeof FROZEN_HP): ScoredReview[] {
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  const out: ScoredReview[] = [];
  for (const r of eligible) {
    const links = combinedLinksFor(r, hp);
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (r.isTestEval) out.push({ cardId: r.cardId, p, y: r.label });
  }
  return out;
}

console.log(`\nvariante (hiperparâmetros CONGELADOS): ${JSON.stringify(FROZEN_HP)}`);
const combinedTest = evalCombinedModel(FROZEN_HP);
console.log(`variante teste: n=${combinedTest.length} logLoss=${logLoss(combinedTest).toFixed(4)} AUC=${auc(combinedTest).toFixed(4)}`);
checkMemory("after variant");

// Equivalence check: lambdaExtra=0 (same priorVariance/driftPerDay/lambdaDeck as the base) must reproduce the base exactly.
const zeroHp = { priorVariance: deckGridBest!.priorVariance, driftPerDay: deckGridBest!.driftPerDay, lambdaDeck: deckGridBest!.lambda, lambdaExtra: 0 };
const zeroTest = evalCombinedModel(zeroHp);
let maxDiff = 0;
for (let i = 0; i < deckTest.length; i++) maxDiff = Math.max(maxDiff, Math.abs(deckTest[i]!.p - zeroTest[i]!.p));
console.log(`\nverificação (lambdaExtra=0 vs base): diferença máx=${maxDiff} ${maxDiff < 1e-12 ? "(OK)" : "(FALHOU)"}`);

// ---------------------------------------------------------------------------
// Bootstrap by session.
// ---------------------------------------------------------------------------

const testSessionIds = eligible.filter((r) => r.isTestEval).map((r) => r.sessionId);
const boot = bootstrapLogLossDeltaByGroup(deckTest, combinedTest, testSessionIds, { iterations: 3000, seed: 42 });
console.log(`\nbootstrap por sessão (3000x) vs base: Δ=${boot.meanDelta.toFixed(4)} CI95=[${boot.ci95[0].toFixed(4)}, ${boot.ci95[1].toFixed(4)}]`);
const favors = boot.ci95[0] > 0;
console.log(`IC inteiramente a favor da variante? ${favors}`);

console.log(`\nPico de RSS observado: ${(peakRssBytes / 1e9).toFixed(2)}GB`);
clearInterval(rssSampler);
console.timeEnd("total");
