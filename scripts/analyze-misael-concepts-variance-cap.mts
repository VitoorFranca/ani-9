// EXPLORATORY amendment (see MISAEL_CONCEPTS_PROTOCOL.md, decided after
// seeing the registered result): caps variance at priorVariance right after
// drift, before the Bayesian update, applied uniformly to every node
// (deck, topic, list-concept) -- including the base itself. Implemented as
// a local model class; does NOT modify src/model/bayesian.ts, so the
// already-registered result stays reproducible unchanged.
import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { ingestApkgFile, openApkgDatabase } from "../src/ingest/index.ts";
import { buildNormalizedCards } from "../src/content/build.ts";
import { FSRSAlgorithm, generatorParameters } from "ts-fsrs";
import { replayAll, splitChronological, optimizeParameters } from "../src/fsrs/index.ts";
import type { ReplayedReview } from "../src/fsrs/replay.ts";
import type { WeightedLink } from "../src/model/index.ts";
import { logLoss, auc, bootstrapLogLossDelta, type ScoredReview } from "../src/eval/index.ts";
import type { Review } from "../src/ingest/types.ts";
import type { NormalizedCard } from "../src/content/types.ts";

const DAY_MS = 86_400_000;
const DIR = "./data/misael";
const CACHE_DIR = "./cache";
const MAX_RSS_BYTES = 3.5 * 1024 * 1024 * 1024;
const PERMUTATIONS = Number(process.env["MISAEL_PERMUTATIONS"] ?? 10);
console.log(`PERMUTATIONS=${PERMUTATIONS}${PERMUTATIONS !== 1000 ? " (ENSAIO — não é a rodada completa)" : ""}`);
console.time("total");

let peakRssBytes = 0;
const rssSampler = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 500);
rssSampler.unref();
function checkMemory(where: string): void {
  const rss = process.memoryUsage().rss;
  peakRssBytes = Math.max(peakRssBytes, rss);
  if (rss > MAX_RSS_BYTES) {
    console.error(`ABORTANDO em "${where}": RSS=${(rss / 1e9).toFixed(2)}GB excede o teto de ${(MAX_RSS_BYTES / 1e9).toFixed(2)}GB`);
    clearInterval(rssSampler);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Variance-CEILED model: identical math to GraphBayesianModel, except
// variance is capped at priorVariance right after drift, before the
// prediction/update step. The original MIN_VARIANCE floor (from the update
// step) is untouched -- "sem piso" per the amendment.
// ---------------------------------------------------------------------------
const MIN_VARIANCE = 1e-6;
function clampProbability(p: number): number { return Math.min(1 - 1e-4, Math.max(1e-4, p)); }
function logit(p: number): number { const c = clampProbability(p); return Math.log(c / (1 - c)); }
function sigmoid(z: number): number { return 1 / (1 + Math.exp(-z)); }

interface CeiledNode { theta: number; variance: number; lastUpdateDay: number }
class VarianceCeiledModel {
  private nodes = new Map<string, CeiledNode>();
  constructor(private hp: { priorVariance: number; driftPerDay: number }) {}
  getState(id: string): { theta: number; variance: number } | undefined {
    const n = this.nodes.get(id);
    return n ? { theta: n.theta, variance: n.variance } : undefined;
  }
  private getOrInit(id: string, day: number): CeiledNode {
    let n = this.nodes.get(id);
    if (!n) { n = { theta: 0, variance: this.hp.priorVariance, lastUpdateDay: day }; this.nodes.set(id, n); }
    return n;
  }
  predictAndUpdate(links: readonly WeightedLink<string>[], fsrsR: number, y: 0 | 1, day: number): number {
    const entries = links.map((link) => ({ link, node: this.getOrInit(link.id, day) }));
    for (const { node } of entries) {
      const elapsed = Math.max(0, day - node.lastUpdateDay);
      node.variance += this.hp.driftPerDay * elapsed;
      node.variance = Math.min(node.variance, this.hp.priorVariance); // <-- the one change
      node.lastUpdateDay = day;
    }
    const z = logit(fsrsR) + entries.reduce((s, { link, node }) => s + link.weight * node.theta, 0);
    const p = sigmoid(z);
    const s = entries.reduce((sum, { link, node }) => sum + link.weight ** 2 * node.variance, 0);
    const denom = 1 + p * (1 - p) * s;
    for (const { link, node } of entries) {
      node.theta += (node.variance * link.weight * (y - p)) / denom;
      const varianceStep = ((node.variance * link.weight) ** 2 * p * (1 - p)) / denom;
      node.variance = Math.max(MIN_VARIANCE, node.variance - varianceStep);
    }
    return p;
  }
}

// ---------------------------------------------------------------------------
// Setup — identical ingestion to analyze-misael-concepts.mts.
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
const listConceptsByCard = new Map<number, string[]>(
  JSON.parse(readFileSync(`${CACHE_DIR}/misael-classify-all.json`, "utf8")) as [number, string[]][],
);

const { train, test } = splitChronological(allReviews);
const cutoffId = test[0]?.id ?? Infinity;
const opt = await optimizeParameters(train);
const fsrsAlgo = new FSRSAlgorithm(generatorParameters({ w: opt.optimizedParameters ?? opt.defaultParameters }));
const replayed: ReplayedReview[] = replayAll(fsrsAlgo, allReviews);

interface EligibleReview {
  cardId: number; predictedR: number; label: 0 | 1; day: number;
  isTrainPeriod: boolean; isTrainEval: boolean; isTestEval: boolean;
}
const eligible: EligibleReview[] = [];
for (const r of replayed) {
  if (r.predictedR === null) continue;
  const isTrainPeriod = r.reviewId < cutoffId;
  eligible.push({
    cardId: r.cardId, predictedR: r.predictedR, label: r.label,
    day: Math.floor(r.reviewId / DAY_MS), isTrainPeriod,
    isTrainEval: isTrainPeriod && r.includedInEval,
    isTestEval: !isTrainPeriod && r.includedInEval,
  });
}
checkMemory("after FSRS replay");

const deckConceptsByCard = new Map<number, string[]>();
for (const cardId of allCards.keys()) deckConceptsByCard.set(cardId, [`deck:${deckByCard.get(cardId)}`]);

const PRIOR_VARIANCE_GRID = [0.25, 1];
const DRIFT_PER_DAY_GRID = [0.001, 0.01];
const LAMBDA_GRID = [0, 0.25, 0.5, 1, 2];

// --- Base (FSRS+deck), recomputed with the variance-ceiled model. ---
interface ConceptHp { priorVariance: number; driftPerDay: number; lambda: number }
// Cards absent from deckByCard (contentless, excluded from allCards) must
// fall back to raw FSRS (no links) -- matching combinedLinks exactly.
// A prior run without this check produced a deck:undefined link with
// nonzero weight for those cards here, while combinedLinks correctly
// no-opped them, breaking the lambdaExtra=0 equivalence check (max diff
// 0.1067 instead of 0).
function deckLinks(cardId: number, hp: ConceptHp): WeightedLink<string>[] {
  const deck = deckByCard.get(cardId);
  return deck === undefined ? [] : [{ id: `deck:${deck}`, weight: hp.lambda }];
}
function scoreDeckLogLoss(hp: ConceptHp, trainOnly: boolean): number {
  const model = new VarianceCeiledModel({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  let sum = 0, count = 0;
  for (const r of eligible) {
    if (trainOnly && !r.isTrainPeriod) break;
    const included = trainOnly ? r.isTrainEval : r.isTestEval;
    const links = deckLinks(r.cardId, hp);
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (included) {
      const clamped = clampProbability(p);
      sum += r.label === 1 ? -Math.log(clamped) : -Math.log(1 - clamped);
      count++;
    }
  }
  return count > 0 ? sum / count : NaN;
}
function evalDeckModel(hp: ConceptHp): ScoredReview[] {
  const model = new VarianceCeiledModel({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  const out: ScoredReview[] = [];
  for (const r of eligible) {
    const links = deckLinks(r.cardId, hp);
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (r.isTestEval) out.push({ cardId: r.cardId, p, y: r.label });
  }
  return out;
}
function deckGridSearch(): { best: ConceptHp; trainLogLoss: number } {
  let best: ConceptHp | null = null, bestLoss = Infinity;
  for (const priorVariance of PRIOR_VARIANCE_GRID) for (const driftPerDay of DRIFT_PER_DAY_GRID) for (const lambda of LAMBDA_GRID) {
    const hp = { priorVariance, driftPerDay, lambda };
    const loss = scoreDeckLogLoss(hp, true);
    if (loss < bestLoss) { bestLoss = loss; best = hp; }
  }
  return { best: best!, trainLogLoss: bestLoss };
}
const deckGrid = deckGridSearch();
const deckTest = evalDeckModel(deckGrid.best);

function evalFsrs(): ScoredReview[] {
  const out: ScoredReview[] = [];
  for (const r of eligible) { if (r.isTestEval) out.push({ cardId: r.cardId, p: r.predictedR, y: r.label }); }
  return out;
}
const fsrsPreds = evalFsrs();
console.log(`FSRS (teste espaçado): n=${fsrsPreds.length} logLoss=${logLoss(fsrsPreds).toFixed(4)} AUC=${auc(fsrsPreds).toFixed(4)}`);
console.log(`Nova base com teto (FSRS+deck, variância <= priorVariance): grid=${JSON.stringify(deckGrid.best)} logLoss(teste)=${logLoss(deckTest).toFixed(4)} AUC=${auc(deckTest).toFixed(4)}`);
checkMemory("after capped base");

// --- Combined (deck + extra), variance-ceiled, separate lambdas. ---
interface CombinedHp { priorVariance: number; driftPerDay: number; lambdaDeck: number; lambdaExtra: number }
function combinedLinks(cardId: number, hp: CombinedHp, extraByCard: ReadonlyMap<number, string[]>): WeightedLink<string>[] {
  const deck = deckByCard.get(cardId);
  if (deck === undefined) return [];
  const extra = extraByCard.get(cardId) ?? [];
  const links: WeightedLink<string>[] = [{ id: `deck:${deck}`, weight: hp.lambdaDeck }];
  for (const name of extra) links.push({ id: name, weight: hp.lambdaExtra / extra.length });
  return links;
}
function scoreCombinedLogLoss(hp: CombinedHp, trainOnly: boolean, extraByCard: ReadonlyMap<number, string[]>): number {
  const model = new VarianceCeiledModel({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  let sum = 0, count = 0;
  for (const r of eligible) {
    if (trainOnly && !r.isTrainPeriod) break;
    const included = trainOnly ? r.isTrainEval : r.isTestEval;
    const links = combinedLinks(r.cardId, hp, extraByCard);
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (included) {
      const clamped = clampProbability(p);
      sum += r.label === 1 ? -Math.log(clamped) : -Math.log(1 - clamped);
      count++;
    }
  }
  return count > 0 ? sum / count : NaN;
}
function evalCombinedModel(hp: CombinedHp, extraByCard: ReadonlyMap<number, string[]>): ScoredReview[] {
  const model = new VarianceCeiledModel({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  const out: ScoredReview[] = [];
  for (const r of eligible) {
    const links = combinedLinks(r.cardId, hp, extraByCard);
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (r.isTestEval) out.push({ cardId: r.cardId, p, y: r.label });
  }
  return out;
}
function combinedGridSearch(extraByCard: ReadonlyMap<number, string[]>): { best: CombinedHp; trainLogLoss: number } {
  let best: CombinedHp | null = null, bestLoss = Infinity;
  for (const priorVariance of PRIOR_VARIANCE_GRID) for (const driftPerDay of DRIFT_PER_DAY_GRID) for (const lambdaDeck of LAMBDA_GRID) for (const lambdaExtra of LAMBDA_GRID) {
    const hp = { priorVariance, driftPerDay, lambdaDeck, lambdaExtra };
    const loss = scoreCombinedLogLoss(hp, true, extraByCard);
    if (loss < bestLoss) { bestLoss = loss; best = hp; }
  }
  return { best: best!, trainLogLoss: bestLoss };
}

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
function shuffleExtraOnly(extraByCard: ReadonlyMap<number, string[]>, seed: number): Map<number, string[]> {
  const cardIds = [...allCards.keys()];
  const values = cardIds.map((id) => extraByCard.get(id) ?? []);
  const shuffled = seededShuffle(values, seed);
  const result = new Map<number, string[]>();
  cardIds.forEach((id, i) => result.set(id, shuffled[i]!));
  return result;
}
function permutationTest(label: string, realLogLoss: number, runOnce: (seed: number) => number, iterations: number): number {
  if (iterations <= 0) { console.log(`${label}: permutação pulada`); return NaN; }
  const shuffleLosses: number[] = [];
  console.time(label);
  for (let seed = 1; seed <= iterations; seed++) {
    shuffleLosses.push(runOnce(seed * 1000 + 7));
    if (seed % Math.max(1, Math.floor(iterations / 10)) === 0 || seed === iterations) {
      console.log(`  ${label}: ${seed}/${iterations} (RSS=${(process.memoryUsage().rss / 1e9).toFixed(2)}GB)`);
    }
    checkMemory(`${label} permutation ${seed}`);
  }
  console.timeEnd(label);
  const beatOrTied = shuffleLosses.filter((l) => l <= realLogLoss).length;
  const p = (beatOrTied + 1) / (shuffleLosses.length + 1);
  const mean = shuffleLosses.reduce((s, l) => s + l, 0) / shuffleLosses.length;
  console.log(`${label}: real=${realLogLoss.toFixed(4)} média_embaralhada=${mean.toFixed(4)} p empírico≈${p.toFixed(4)} (${beatOrTied}/${iterations} <= real)`);
  return p;
}
function ciFavorsComparison(ci: [number, number]): boolean { return ci[0] > 0; }

function runVariant(label: string, extraByCard: ReadonlyMap<number, string[]>) {
  console.log(`\n${"=".repeat(78)}\n${label}\n${"=".repeat(78)}`);
  const grid = combinedGridSearch(extraByCard);
  const test = evalCombinedModel(grid.best, extraByCard);
  console.log(`grid: ${JSON.stringify(grid.best)} trainLogLoss=${grid.trainLogLoss.toFixed(4)}`);
  console.log(`teste: n=${test.length} logLoss=${logLoss(test).toFixed(4)} AUC=${auc(test).toFixed(4)}`);

  const zeroHp: CombinedHp = { priorVariance: deckGrid.best.priorVariance, driftPerDay: deckGrid.best.driftPerDay, lambdaDeck: deckGrid.best.lambda, lambdaExtra: 0 };
  const zeroTest = evalCombinedModel(zeroHp, extraByCard);
  let maxDiff = 0;
  for (let i = 0; i < deckTest.length; i++) maxDiff = Math.max(maxDiff, Math.abs(deckTest[i]!.p - zeroTest[i]!.p));
  console.log(`verificação (lambdaExtra=0 vs nova base com teto): diferença máx=${maxDiff} ${maxDiff < 1e-12 ? "(OK)" : "(FALHOU)"}`);

  const bootVsBase = bootstrapLogLossDelta(deckTest, test, { iterations: 3000, seed: 42 });
  console.log(`bootstrap 3000x vs base: Δ=${bootVsBase.meanDelta.toFixed(4)} CI95=[${bootVsBase.ci95[0].toFixed(4)}, ${bootVsBase.ci95[1].toFixed(4)}]`);
  const favors = ciFavorsComparison(bootVsBase.ci95);
  console.log(`IC inteiramente a favor da variante? ${favors}`);

  let permutationP: number | null = null;
  if (favors) {
    permutationP = permutationTest(`${label} (permutação)`, logLoss(test), (seed) => {
      const shuffled = shuffleExtraOnly(extraByCard, seed);
      const g = combinedGridSearch(shuffled);
      return scoreCombinedLogLoss(g.best, false, shuffled);
    }, PERMUTATIONS);
  } else {
    console.log(`IC não favorece — PARADO aqui, resultado exploratório final para "${label}".`);
  }
  return { grid, test, bootVsBase, favors, permutationP };
}

const listResult = runVariant("[EXPLORATÓRIO] Base com teto + lista fixa", listConceptsByCard);
checkMemory("after list variant");
const topicResult = runVariant("[EXPLORATÓRIO] Base com teto + tópico", topicByCard);
checkMemory("after topic variant");

console.log(`\n${"=".repeat(78)}\nResumo (exploratório)\n${"=".repeat(78)}`);
console.log(`Lista fixa: IC favorável? ${listResult.favors}${listResult.permutationP !== null ? ` — permutação p=${listResult.permutationP.toFixed(4)} (${PERMUTATIONS}x)` : ""}`);
console.log(`Tópico:     IC favorável? ${topicResult.favors}${topicResult.permutationP !== null ? ` — permutação p=${topicResult.permutationP.toFixed(4)} (${PERMUTATIONS}x)` : ""}`);

console.log(`\nPico de RSS observado: ${(peakRssBytes / 1e9).toFixed(2)}GB`);
clearInterval(rssSampler);
console.timeEnd("total");
