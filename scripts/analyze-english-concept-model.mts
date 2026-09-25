process.loadEnvFile(".env");
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { ingestApkgFile } from "../src/ingest/index.ts";
import { buildNormalizedCards } from "../src/content/build.ts";
import { splitChronological, optimizeParameters, replayAll } from "../src/fsrs/index.ts";
import { FSRSAlgorithm, generatorParameters } from "ts-fsrs";
import { classifyCards } from "../src/concepts/classify.ts";
import { extractVocabularyConcepts } from "../src/concepts/vocabulary.ts";
import { GraphBayesianModel } from "../src/model/bayesian.ts";
import { computeConceptNoteCoverage, sameNoteOnlyConcepts, removeConcepts } from "../src/model/concept-coverage.ts";
import {
  logLoss, accuracy, auc, calibrationRmse, constantBaselinePredictions, bootstrapLogLossDelta,
  type ScoredReview,
} from "../src/eval/metrics.ts";
import type { ReplayedReview } from "../src/fsrs/replay.ts";
import type { WeightedLink } from "../src/model/bayesian.ts";

const DAY_MS = 86_400_000;
console.time("total");

const FIXED_LIST = [
  "phrasal verb: get away with", "phrasal verb: pass away", "phrasal verb: sleep over",
  "phrasal verb: call off", "phrasal verb: pull together", "phrasal verb: come up with",
  "phrasal verb: find out", "phrasal verb: back up", "phrasal verb: dress up",
  "phrasal verb: go back", "phrasal verb: keep on", "phrasal verb: sober up",
  "expressão idiomática: take for granted", "expressão idiomática: long shot",
  "expressão idiomática: when it comes to", "expressão idiomática: so far, so good",
  "expressão idiomática: not my cup of tea", "expressão idiomática: can't help but",
  "expressão idiomática: at all", "expressão idiomática: go against",
  "expressão idiomática: I'll have you know", "expressão idiomática: might as well",
];

// --- Ingest + FSRS baseline ---
const { collection, reviews } = await ingestApkgFile("./data/English.apkg");
const normalized = buildNormalizedCards(collection);
const reviewedCardIds = new Set(reviews.map(r => r.cardId));
const eligible = normalized.filter(c => !c.contentless && reviewedCardIds.has(c.cardId));
const noteIdByCard = new Map(eligible.map(c => [c.cardId, c.noteId]));

const { train, test } = splitChronological(reviews);
const cutoffId = test[0]?.id ?? Infinity;

const opt = await optimizeParameters(train);
const fsrsAlgo = new FSRSAlgorithm(generatorParameters({ w: opt.optimizedParameters ?? opt.defaultParameters }));
const replayed: ReplayedReview[] = replayAll(fsrsAlgo, reviews);

// --- Classify + vocabulary (cached after first real Gemini call) ---
const CACHE_PATH = "./cache/classify-english-fixed-list.json";
let listConceptsByCard: Map<number, string[]>;
if (existsSync(CACHE_PATH)) {
  const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as [number, string[]][];
  listConceptsByCard = new Map(raw);
  console.log(`classify: loaded ${listConceptsByCard.size} cards from cache (${CACHE_PATH})`);
} else {
  const client = new GoogleGenAI({});
  console.time("classify");
  const result = await classifyCards(
    eligible.map(c => ({ cardId: c.cardId, front: c.front, back: c.back })),
    { client, fixedList: FIXED_LIST, batchSize: 40 },
  );
  console.timeEnd("classify");
  listConceptsByCard = result.conceptsByCard;
  console.log("classify stats:", JSON.stringify(result.stats, null, 2));
  console.log(`classify cost: $${(result.stats.inputTokens/1e6*0.25 + result.stats.outputTokens/1e6*1.50).toFixed(5)}`);
  mkdirSync("./cache", { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify([...listConceptsByCard.entries()]));
}

const allConceptsByCard = new Map<number, string[]>();
for (const c of eligible) {
  const vocab = extractVocabularyConcepts(c.front).map(v => v.name);
  allConceptsByCard.set(c.cardId, [...(listConceptsByCard.get(c.cardId) ?? []), ...vocab]);
}

// --- Point 1: distinct notes per concept ---
const noteCoverage = computeConceptNoteCoverage(allConceptsByCard, noteIdByCard);
const sameNoteOnly = sameNoteOnlyConcepts(noteCoverage);
console.log(`\n=== Passo 1: notas distintas por conceito ===`);
console.log(`total de cartões=${eligible.length}, total de notas distintas=${new Set(eligible.map(c=>c.noteId)).size} (razão cartão:nota = ${(eligible.length/new Set(eligible.map(c=>c.noteId)).size).toFixed(2)})`);
console.log(`total de conceitos distintos: ${noteCoverage.size}`);
console.log(`conceitos que só ligam cartões de UMA nota: ${sameNoteOnly.size}`);
if (sameNoteOnly.size > 0 && sameNoteOnly.size <= 30) {
  console.log(`  lista: ${[...sameNoteOnly].join(", ")}`);
}
// distribution for fixed-list concepts specifically (more interesting than per-word vocab)
console.log(`\nnotas distintas por conceito da lista fixa:`);
for (const name of FIXED_LIST) {
  const notes = noteCoverage.get(name);
  console.log(`  ${notes ? notes.size : 0} notas — "${name}"`);
}

const conceptsWithoutSameNote = removeConcepts(allConceptsByCard, sameNoteOnly);

// --- Build links + eval helpers ---
function linksFor(conceptsByCard: Map<number, string[]>, cardId: number, lambda: number): WeightedLink<string>[] {
  return (conceptsByCard.get(cardId) ?? []).map(name => ({ id: name, weight: lambda }));
}

function runConceptModel(conceptsByCard: Map<number, string[]>, hp: { priorVariance: number; driftPerDay: number; lambda: number }, trainOnly: boolean): ScoredReview[] {
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  const out: ScoredReview[] = [];
  for (const r of replayed) {
    if (r.predictedR === null) continue;
    if (trainOnly && r.reviewId >= cutoffId) continue;
    const day = Math.floor(r.reviewId / DAY_MS);
    const links = linksFor(conceptsByCard, r.cardId, hp.lambda);
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, day) : r.predictedR;
    const isTestPeriod = r.reviewId >= cutoffId;
    if (trainOnly ? r.includedInEval : isTestPeriod && r.includedInEval) {
      out.push({ cardId: r.cardId, p, y: r.label });
    }
  }
  return out;
}

const PRIOR_VARIANCE_GRID = [0.25, 1];
const DRIFT_PER_DAY_GRID = [0.001, 0.01];
const LAMBDA_GRID = [0, 0.25, 0.5, 1, 2];

function jointGridSearch(conceptsByCard: Map<number, string[]>) {
  let best: { priorVariance: number; driftPerDay: number; lambda: number } | null = null;
  let bestLoss = Infinity;
  for (const priorVariance of PRIOR_VARIANCE_GRID) {
    for (const driftPerDay of DRIFT_PER_DAY_GRID) {
      for (const lambda of LAMBDA_GRID) {
        const hp = { priorVariance, driftPerDay, lambda };
        const loss = logLoss(runConceptModel(conceptsByCard, hp, true));
        if (loss < bestLoss) { bestLoss = loss; best = hp; }
      }
    }
  }
  return { best: best!, logLoss: bestLoss };
}

// --- Point 2/3: run with and without same-note-only concepts, report in 2 cuts ---
const crossNoteConcepts = new Set([...noteCoverage.keys()].filter(c => !sameNoteOnly.has(c)));
const cardsWithCrossNoteConcept = new Set(
  eligible.filter(c => (allConceptsByCard.get(c.cardId) ?? []).some(name => crossNoteConcepts.has(name))).map(c => c.cardId)
);
console.log(`\ncartões com >=1 conceito de notas distintas: ${cardsWithCrossNoteConcept.size} / ${eligible.length}`);

function evalFsrs(): ScoredReview[] {
  const out: ScoredReview[] = [];
  for (const r of replayed) {
    if (r.reviewId < cutoffId || !r.includedInEval || r.predictedR === null) continue;
    out.push({ cardId: r.cardId, p: r.predictedR, y: r.label });
  }
  return out;
}
const fsrsPreds = evalFsrs();
const trainEvalLabels = replayed.filter(r => r.reviewId < cutoffId && r.includedInEval).map(r => r.label);
const constantPreds = constantBaselinePredictions(trainEvalLabels, fsrsPreds);

function reportCut(label: string, preds: ScoredReview[], cardFilter?: Set<number>) {
  const filtered = cardFilter ? preds.filter(p => cardFilter.has(p.cardId)) : preds;
  if (filtered.length === 0) { console.log(`${label}: n=0 (sem dados)`); return; }
  console.log(`${label}: n=${filtered.length} logLoss=${logLoss(filtered).toFixed(4)} accuracy(hit-rate)=${(100*accuracy(filtered)).toFixed(1)}% AUC=${auc(filtered).toFixed(4)} calibRMSE=${calibrationRmse(filtered,10).toFixed(4)}`);
}

console.log(`\n=== Grid search (treino) — COM conceitos same-note ===`);
const gridWith = jointGridSearch(allConceptsByCard);
console.log(`best hp: ${JSON.stringify(gridWith.best)}, train logLoss=${gridWith.logLoss.toFixed(4)}`);
const testPredsWith = runConceptModel(allConceptsByCard, gridWith.best, false);

console.log(`\n=== Grid search (treino) — SEM conceitos same-note ===`);
const gridWithout = jointGridSearch(conceptsWithoutSameNote);
console.log(`best hp: ${JSON.stringify(gridWithout.best)}, train logLoss=${gridWithout.logLoss.toFixed(4)}`);
const testPredsWithout = runConceptModel(conceptsWithoutSameNote, gridWithout.best, false);

console.log(`\n=== Passo 3: métricas em dois recortes ===`);
console.log(`\n--- Recorte: TODOS os cartões (n=${fsrsPreds.length}) ---`);
reportCut("Constante", constantPreds);
reportCut("FSRS otimizado", fsrsPreds);
reportCut("Modelo de conceitos (com same-note)", testPredsWith);
reportCut("Modelo de conceitos (sem same-note)", testPredsWithout);

console.log(`\n--- Recorte: só cartões com >=1 conceito de notas distintas ---`);
reportCut("Constante", constantPreds, cardsWithCrossNoteConcept);
reportCut("FSRS otimizado", fsrsPreds, cardsWithCrossNoteConcept);
reportCut("Modelo de conceitos (com same-note)", testPredsWith, cardsWithCrossNoteConcept);
reportCut("Modelo de conceitos (sem same-note)", testPredsWithout, cardsWithCrossNoteConcept);

console.log(`\n=== Bootstrap por cartão (recorte: TODOS os cartões) ===`);
{
  const bootAllWith = bootstrapLogLossDelta(fsrsPreds, testPredsWith, { iterations: 3000, seed: 42 });
  console.log(`FSRS vs conceitos(com same-note): Δ=${bootAllWith.meanDelta.toFixed(4)} CI95=[${bootAllWith.ci95[0].toFixed(4)}, ${bootAllWith.ci95[1].toFixed(4)}]`);
  const bootAllWithout = bootstrapLogLossDelta(fsrsPreds, testPredsWithout, { iterations: 3000, seed: 42 });
  console.log(`FSRS vs conceitos(sem same-note): Δ=${bootAllWithout.meanDelta.toFixed(4)} CI95=[${bootAllWithout.ci95[0].toFixed(4)}, ${bootAllWithout.ci95[1].toFixed(4)}]`);
}

console.log(`\n=== Bootstrap por cartão (recorte: cartões com conceito de notas distintas) ===`);
const fsrsCross = fsrsPreds.filter(p => cardsWithCrossNoteConcept.has(p.cardId));
const withCross = testPredsWith.filter(p => cardsWithCrossNoteConcept.has(p.cardId));
const withoutCross = testPredsWithout.filter(p => cardsWithCrossNoteConcept.has(p.cardId));
if (fsrsCross.length === withCross.length && fsrsCross.length > 0) {
  const boot1 = bootstrapLogLossDelta(fsrsCross, withCross, { iterations: 3000, seed: 42 });
  console.log(`FSRS vs conceitos(com same-note): Δ=${boot1.meanDelta.toFixed(4)} CI95=[${boot1.ci95[0].toFixed(4)}, ${boot1.ci95[1].toFixed(4)}]`);
}
if (fsrsCross.length === withoutCross.length && fsrsCross.length > 0) {
  const boot2 = bootstrapLogLossDelta(fsrsCross, withoutCross, { iterations: 3000, seed: 42 });
  console.log(`FSRS vs conceitos(sem same-note): Δ=${boot2.meanDelta.toFixed(4)} CI95=[${boot2.ci95[0].toFixed(4)}, ${boot2.ci95[1].toFixed(4)}]`);
}

// ============================================================
// CONTROLES — recorte "só cross-note" (cardsWithCrossNoteConcept)
// ============================================================

function clampP(p: number): number {
  return Math.min(1 - 1e-4, Math.max(1e-4, p));
}
function logitFn(p: number): number {
  const c = clampP(p);
  return Math.log(c / (1 - c));
}
function sigmoidFn(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

// --- Controle 1: FSRS + viés global único (ajustado no treino) ---
console.log(`\n=== Controle 1: FSRS recalibrado (viés global, ajustado no treino) ===`);
const trainFsrsPreds: ScoredReview[] = [];
for (const r of replayed) {
  if (r.reviewId >= cutoffId || !r.includedInEval || r.predictedR === null) continue;
  trainFsrsPreds.push({ cardId: r.cardId, p: r.predictedR, y: r.label });
}

function fitGlobalBias(preds: readonly ScoredReview[]): number {
  let best = 0;
  let bestLoss = Infinity;
  for (let b = -4; b <= 4; b += 0.01) {
    const adjusted = preds.map((r) => ({ ...r, p: sigmoidFn(logitFn(r.p) + b) }));
    const loss = logLoss(adjusted);
    if (loss < bestLoss) { bestLoss = loss; best = b; }
  }
  return best;
}

const globalBias = fitGlobalBias(trainFsrsPreds);
console.log(`viés global ajustado (treino): b=${globalBias.toFixed(3)}`);

const fsrsRecalibratedPreds = fsrsPreds.map((r) => ({ ...r, p: sigmoidFn(logitFn(r.p) + globalBias) }));
const fsrsRecalibratedCross = fsrsRecalibratedPreds.filter((p) => cardsWithCrossNoteConcept.has(p.cardId));

reportCut("FSRS recalibrado (viés global)", fsrsRecalibratedPreds, cardsWithCrossNoteConcept);
reportCut("Modelo de conceitos (com same-note)", testPredsWith, cardsWithCrossNoteConcept);

const bootRecal = bootstrapLogLossDelta(fsrsRecalibratedCross, withCross, { iterations: 3000, seed: 42 });
console.log(`FSRS recalibrado vs conceitos: Δ=${bootRecal.meanDelta.toFixed(4)} CI95=[${bootRecal.ci95[0].toFixed(4)}, ${bootRecal.ci95[1].toFixed(4)}]`);

// --- Controle 2: conceitos embaralhados entre cartões (20x) ---
console.log(`\n=== Controle 2: conceitos embaralhados entre cartões (20 permutações) ===`);

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0; state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

// Permutes WHICH card gets which concept-list, preserving each card's
// concept count exactly (it's the same set of lists, just reassigned) and
// the global concept-frequency distribution exactly (same multiset of lists).
function shuffleConceptsByCard(conceptsByCard: Map<number, string[]>, seed: number): Map<number, string[]> {
  const cardIds = [...conceptsByCard.keys()];
  const lists = cardIds.map((id) => conceptsByCard.get(id)!);
  const shuffledLists = seededShuffle(lists, seed);
  const result = new Map<number, string[]>();
  cardIds.forEach((id, i) => result.set(id, shuffledLists[i]!));
  return result;
}

const realLogLossCross = logLoss(withCross);
console.log(`log-loss real (conceitos, recorte cross-note): ${realLogLossCross.toFixed(4)}`);
console.log(`(cada permutação refaz a MESMA busca em grade de priorVariance/driftPerDay/lambda no treino, não reaproveita gridWith.best)`);

const PERMUTATIONS = 1000;
const shuffleLogLosses: number[] = [];
console.time("permutations");
for (let seed = 1; seed <= PERMUTATIONS; seed++) {
  const shuffled = shuffleConceptsByCard(allConceptsByCard, seed * 1000 + 7);
  const grid = jointGridSearch(shuffled);
  const shuffledPreds = runConceptModel(shuffled, grid.best, false);
  const shuffledCross = shuffledPreds.filter((p) => cardsWithCrossNoteConcept.has(p.cardId));
  shuffleLogLosses.push(logLoss(shuffledCross));
  if (seed % 100 === 0) console.log(`  ... ${seed}/${PERMUTATIONS} permutações concluídas`);
}
console.timeEnd("permutations");

const meanShuffled = shuffleLogLosses.reduce((s, l) => s + l, 0) / shuffleLogLosses.length;
const sdShuffled = Math.sqrt(
  shuffleLogLosses.reduce((s, l) => s + (l - meanShuffled) ** 2, 0) / shuffleLogLosses.length,
);
const beatOrTiedReal = shuffleLogLosses.filter((l) => l <= realLogLossCross).length;
const permutationP = (beatOrTiedReal + 1) / (shuffleLogLosses.length + 1);

const sortedShuffled = [...shuffleLogLosses].sort((a, b) => a - b);
const percentile = (p: number) => sortedShuffled[Math.floor(p * (sortedShuffled.length - 1))]!;

console.log(`\ndistribuição das ${PERMUTATIONS} permutações (log-loss, recorte cross-note):`);
console.log(`  média=${meanShuffled.toFixed(4)} desvio=${sdShuffled.toFixed(4)} min=${sortedShuffled[0]!.toFixed(4)} max=${sortedShuffled.at(-1)!.toFixed(4)}`);
console.log(`  p1=${percentile(0.01).toFixed(4)} p5=${percentile(0.05).toFixed(4)} p25=${percentile(0.25).toFixed(4)} p50=${percentile(0.50).toFixed(4)} p75=${percentile(0.75).toFixed(4)} p95=${percentile(0.95).toFixed(4)} p99=${percentile(0.99).toFixed(4)}`);
console.log(`real (conceitos verdadeiros): ${realLogLossCross.toFixed(4)}`);
console.log(`permutações com logLoss <= real: ${beatOrTiedReal}/${PERMUTATIONS} (p empírico ≈ ${permutationP.toFixed(4)})`);

console.timeEnd("total");
