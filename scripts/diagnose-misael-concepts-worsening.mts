// Diagnostic-only, no API, no protocol changes. Investigates why the list
// and topic variants (MISAEL_CONCEPTS_PROTOCOL.md) score worse than the
// FSRS+deck base on test, despite being picked by grid search on train.
import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { ingestApkgFile, openApkgDatabase } from "../src/ingest/index.ts";
import { buildNormalizedCards } from "../src/content/build.ts";
import { FSRSAlgorithm, generatorParameters } from "ts-fsrs";
import { replayAll, splitChronological, optimizeParameters } from "../src/fsrs/index.ts";
import type { ReplayedReview } from "../src/fsrs/replay.ts";
import { GraphBayesianModel, type WeightedLink } from "../src/model/index.ts";
import { logLoss, type ScoredReview } from "../src/eval/index.ts";
import type { Review } from "../src/ingest/types.ts";
import type { NormalizedCard } from "../src/content/types.ts";

const DAY_MS = 86_400_000;
const DIR = "./data/misael";
const CACHE_DIR = "./cache";

// ---------------------------------------------------------------------------
// Setup — identical to analyze-misael-concepts.mts.
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
  reviewId: number; cardId: number; predictedR: number; label: 0 | 1; day: number;
  isTrainPeriod: boolean; isTrainEval: boolean; isTestEval: boolean;
}
const eligible: EligibleReview[] = [];
for (const r of replayed) {
  if (r.predictedR === null) continue;
  const isTrainPeriod = r.reviewId < cutoffId;
  eligible.push({
    reviewId: r.reviewId, cardId: r.cardId, predictedR: r.predictedR, label: r.label,
    day: Math.floor(r.reviewId / DAY_MS), isTrainPeriod,
    isTrainEval: isTrainPeriod && r.includedInEval,
    isTestEval: !isTrainPeriod && r.includedInEval,
  });
}

const deckConceptsByCard = new Map<number, string[]>();
for (const cardId of allCards.keys()) deckConceptsByCard.set(cardId, [`deck:${deckByCard.get(cardId)}`]);

interface ConceptHp { priorVariance: number; driftPerDay: number; lambda: number }
function scoreConceptLogLoss(conceptsByCard: ReadonlyMap<number, string[]>, hp: ConceptHp, trainOnly: boolean): number {
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  let sum = 0, count = 0;
  for (const r of eligible) {
    if (trainOnly && !r.isTrainPeriod) break;
    const included = trainOnly ? r.isTrainEval : r.isTestEval;
    const names = conceptsByCard.get(r.cardId);
    const links: WeightedLink<string>[] = names && names.length > 0 ? names.map((name) => ({ id: name, weight: hp.lambda })) : [];
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (included) {
      const clamped = Math.min(1 - 1e-4, Math.max(1e-4, p));
      sum += r.label === 1 ? -Math.log(clamped) : -Math.log(1 - clamped);
      count++;
    }
  }
  return count > 0 ? sum / count : NaN;
}
const PRIOR_VARIANCE_GRID = [0.25, 1];
const DRIFT_PER_DAY_GRID = [0.001, 0.01];
const LAMBDA_GRID = [0, 0.25, 0.5, 1, 2];
function conceptGridSearch(conceptsByCard: ReadonlyMap<number, string[]>): { best: ConceptHp; trainLogLoss: number } {
  let best: ConceptHp | null = null, bestLoss = Infinity;
  for (const priorVariance of PRIOR_VARIANCE_GRID) for (const driftPerDay of DRIFT_PER_DAY_GRID) for (const lambda of LAMBDA_GRID) {
    const hp = { priorVariance, driftPerDay, lambda };
    const loss = scoreConceptLogLoss(conceptsByCard, hp, true);
    if (loss < bestLoss) { bestLoss = loss; best = hp; }
  }
  return { best: best!, trainLogLoss: bestLoss };
}
const deckGrid = conceptGridSearch(deckConceptsByCard);

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
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  let sum = 0, count = 0;
  for (const r of eligible) {
    if (trainOnly && !r.isTrainPeriod) break;
    const included = trainOnly ? r.isTrainEval : r.isTestEval;
    const links = combinedLinks(r.cardId, hp, extraByCard);
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (included) {
      const clamped = Math.min(1 - 1e-4, Math.max(1e-4, p));
      sum += r.label === 1 ? -Math.log(clamped) : -Math.log(1 - clamped);
      count++;
    }
  }
  return count > 0 ? sum / count : NaN;
}
function evalCombinedModel(hp: CombinedHp, extraByCard: ReadonlyMap<number, string[]>): ScoredReview[] {
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
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

function evalConceptModelTest(conceptsByCard: ReadonlyMap<number, string[]>, hp: ConceptHp): ScoredReview[] {
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  const out: ScoredReview[] = [];
  for (const r of eligible) {
    const names = conceptsByCard.get(r.cardId);
    const links: WeightedLink<string>[] = names && names.length > 0 ? names.map((name) => ({ id: name, weight: hp.lambda })) : [];
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (r.isTestEval) out.push({ cardId: r.cardId, p, y: r.label });
  }
  return out;
}
const deckTest = evalConceptModelTest(deckConceptsByCard, deckGrid.best);

const variants: { label: string; extraByCard: Map<number, string[]> }[] = [
  { label: "lista fixa", extraByCard: listConceptsByCard },
  { label: "tópico", extraByCard: topicByCard },
];

// ---------------------------------------------------------------------------
// 1. Δ (variante vs base) no treino e no teste.
// ---------------------------------------------------------------------------
console.log("=".repeat(78));
console.log("1. Δ (variante vs base) no treino e no teste");
console.log("=".repeat(78));

const grids = new Map<string, ReturnType<typeof combinedGridSearch>>();
const tests = new Map<string, ScoredReview[]>();
for (const v of variants) {
  const grid = combinedGridSearch(v.extraByCard);
  const testPreds = evalCombinedModel(grid.best, v.extraByCard);
  grids.set(v.label, grid);
  tests.set(v.label, testPreds);
  const deltaTrain = deckGrid.trainLogLoss - grid.trainLogLoss;
  const deltaTest = logLoss(deckTest) - logLoss(testPreds);
  console.log(`\n${v.label}: hp=${JSON.stringify(grid.best)}`);
  console.log(`  treino: base=${deckGrid.trainLogLoss.toFixed(4)} variante=${grid.trainLogLoss.toFixed(4)} Δ=${deltaTrain.toFixed(4)} ${deltaTrain >= 0 ? "(variante <= base, esperado por construção)" : "(inesperado!)"}`);
  console.log(`  teste:  base=${logLoss(deckTest).toFixed(4)} variante=${logLoss(testPreds).toFixed(4)} Δ=${deltaTest.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// 2. Δ por período (trimestre) no teste.
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(78));
console.log("2. Δ por trimestre (teste)");
console.log("=".repeat(78));

function quarterOf(ms: number): string {
  const d = new Date(ms);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
}
const testReviewIdByCardOrder = eligible.filter((r) => r.isTestEval);

for (const v of variants) {
  console.log(`\n--- ${v.label} ---`);
  const testPreds = tests.get(v.label)!;
  // testPreds is in the same iteration order as `eligible` filtered by isTestEval (both evalCombinedModel and the loop above iterate `eligible` in order and push on isTestEval), and so is deckTest — align by index.
  const quarterly = new Map<string, { deck: ScoredReview[]; variant: ScoredReview[] }>();
  testReviewIdByCardOrder.forEach((r, i) => {
    const q = quarterOf(r.reviewId);
    if (!quarterly.has(q)) quarterly.set(q, { deck: [], variant: [] });
    quarterly.get(q)!.deck.push(deckTest[i]!);
    quarterly.get(q)!.variant.push(testPreds[i]!);
  });
  const sortedQuarters = [...quarterly.keys()].sort();
  for (const q of sortedQuarters) {
    const { deck, variant } = quarterly.get(q)!;
    const delta = logLoss(deck) - logLoss(variant);
    console.log(`  ${q}: n=${deck.length} base=${logLoss(deck).toFixed(4)} variante=${logLoss(variant).toFixed(4)} Δ=${delta.toFixed(4)}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Distribuição da variância dos nós "extra" no momento da previsão,
//    treino vs teste. Aproximação: snapshot via getState() imediatamente
//    antes de predictAndUpdate (reflete o valor após o ÚLTIMO toque nesse
//    nó, sem incluir o drift do dia atual ainda — pequena defasagem, dado
//    que driftPerDay é da ordem de 0.001-0.01, negligível frente às
//    variações reais de variância por atualização Bayesiana).
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(78));
console.log("3. Distribuição da variância dos nós extra no momento da previsão (treino vs teste)");
console.log("=".repeat(78));

function stats(xs: number[]): { min: number; p25: number; median: number; p75: number; max: number; mean: number } {
  const sorted = [...xs].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.floor(p * (sorted.length - 1))]!;
  return { min: sorted[0]!, p25: pct(0.25), median: pct(0.5), p75: pct(0.75), max: sorted.at(-1)!, mean: xs.reduce((a, b) => a + b, 0) / xs.length };
}

for (const v of variants) {
  const hp = grids.get(v.label)!.best;
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  const trainVariances: number[] = [];
  const testVariances: number[] = [];
  for (const r of eligible) {
    const extra = v.extraByCard.get(r.cardId) ?? [];
    for (const name of extra) {
      const stateBefore = model.getState(name);
      const varianceNow = stateBefore ? stateBefore.variance : hp.priorVariance;
      if (r.isTrainEval) trainVariances.push(varianceNow);
      else if (r.isTestEval) testVariances.push(varianceNow);
    }
    const links = combinedLinks(r.cardId, hp, v.extraByCard);
    if (links.length > 0) model.predictAndUpdate(links, r.predictedR, r.label, r.day);
  }
  console.log(`\n--- ${v.label} (priorVariance=${hp.priorVariance}) ---`);
  console.log(`  treino (n=${trainVariances.length}): ${JSON.stringify(stats(trainVariances))}`);
  console.log(`  teste  (n=${testVariances.length}): ${JSON.stringify(stats(testVariances))}`);
}

// ---------------------------------------------------------------------------
// 4. [EXPLORATÓRIO] Limitar a variância ao valor inicial (priorVariance):
//    nunca deixa a variância cair abaixo do prior, desabilitando o ganho de
//    confiança por repetição — testa se é isso que causa a piora no teste.
//    Implementado como uma cópia local da matemática de bayesian.ts, com o
//    piso trocado; NÃO altera src/model/bayesian.ts nem o resultado
//    registrado no protocolo.
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(78));
console.log("4. [EXPLORATÓRIO] Variância nunca abaixo de priorVariance");
console.log("=".repeat(78));

function clampProbability(p: number): number { return Math.min(1 - 1e-4, Math.max(1e-4, p)); }
function logit(p: number): number { const c = clampProbability(p); return Math.log(c / (1 - c)); }
function sigmoid(z: number): number { return 1 / (1 + Math.exp(-z)); }

interface FlooredNode { theta: number; variance: number; lastUpdateDay: number }
class VarianceFlooredModel {
  private nodes = new Map<string, FlooredNode>();
  constructor(private hp: { priorVariance: number; driftPerDay: number }) {}
  private getOrInit(id: string, day: number): FlooredNode {
    let n = this.nodes.get(id);
    if (!n) { n = { theta: 0, variance: this.hp.priorVariance, lastUpdateDay: day }; this.nodes.set(id, n); }
    return n;
  }
  predictAndUpdate(links: readonly WeightedLink<string>[], fsrsR: number, y: 0 | 1, day: number): number {
    const entries = links.map((link) => ({ link, node: this.getOrInit(link.id, day) }));
    for (const { node } of entries) {
      const elapsed = Math.max(0, day - node.lastUpdateDay);
      node.variance += this.hp.driftPerDay * elapsed;
      node.lastUpdateDay = day;
    }
    const z = logit(fsrsR) + entries.reduce((s, { link, node }) => s + link.weight * node.theta, 0);
    const p = sigmoid(z);
    const s = entries.reduce((sum, { link, node }) => sum + link.weight ** 2 * node.variance, 0);
    const denom = 1 + p * (1 - p) * s;
    for (const { link, node } of entries) {
      node.theta += (node.variance * link.weight * (y - p)) / denom;
      const varianceStep = ((node.variance * link.weight) ** 2 * p * (1 - p)) / denom;
      node.variance = Math.max(this.hp.priorVariance, node.variance - varianceStep); // <-- floor at priorVariance, not MIN_VARIANCE
    }
    return p;
  }
}

for (const v of variants) {
  const hp = grids.get(v.label)!.best;
  const model = new VarianceFlooredModel({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  const out: ScoredReview[] = [];
  for (const r of eligible) {
    const links = combinedLinks(r.cardId, hp, v.extraByCard);
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (r.isTestEval) out.push({ cardId: r.cardId, p, y: r.label });
  }
  const delta = logLoss(deckTest) - logLoss(out);
  console.log(`${v.label}: logLoss(teste, variância limitada)=${logLoss(out).toFixed(4)} vs base=${logLoss(deckTest).toFixed(4)} Δ=${delta.toFixed(4)} (Δ do resultado registrado, sem limitar: ${(logLoss(deckTest) - logLoss(tests.get(v.label)!)).toFixed(4)})`);
}
