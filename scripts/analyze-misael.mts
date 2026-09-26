// Misael decks — main variant + controls, WITHOUT the embedding-neighbor
// comparison (that requires scripts/embed-misael.mts to have populated the
// disk cache first, and is added back in a later step). Deliberately does
// NOT import src/embeddings/* or src/model/neighbors.ts — no model of any
// kind is loaded in this process.
import { readdir } from "node:fs/promises";
import { ingestApkgFile } from "../src/ingest/index.ts";
import { buildNormalizedCards } from "../src/content/build.ts";
import { FSRSAlgorithm, generatorParameters } from "ts-fsrs";
import { replayAll, splitChronological, optimizeParameters } from "../src/fsrs/index.ts";
import type { ReplayedReview } from "../src/fsrs/replay.ts";
import { extractVocabularyConcepts, PORTUGUESE_FUNCTION_WORDS } from "../src/concepts/vocabulary.ts";
import { GraphBayesianModel, type WeightedLink } from "../src/model/index.ts";
import { logLoss, auc, bootstrapLogLossDelta, constantBaselinePredictions, type ScoredReview } from "../src/eval/index.ts";
import type { Review } from "../src/ingest/types.ts";
import type { NormalizedCard } from "../src/content/types.ts";

const DAY_MS = 86_400_000;
const DIR = "./data/misael";
const MAX_RSS_BYTES = 3.5 * 1024 * 1024 * 1024;
const PERMUTATIONS = Number(process.env["MISAEL_PERMUTATIONS"] ?? 1000);
console.log(`PERMUTATIONS=${PERMUTATIONS}${PERMUTATIONS !== 1000 ? " (ENSAIO — não é a rodada completa)" : ""}`);
console.time("total");

let peakRssBytes = 0;
const rssSampler = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}, 500);
rssSampler.unref();

function checkMemory(where: string): void {
  const rss = process.memoryUsage().rss;
  peakRssBytes = Math.max(peakRssBytes, rss);
  if (rss > MAX_RSS_BYTES) {
    console.error(`ABORTANDO em "${where}": RSS=${(rss / 1e9).toFixed(2)}GB excede o teto de ${(MAX_RSS_BYTES / 1e9).toFixed(2)}GB`);
    console.error(`Pico de RSS observado antes de abortar: ${(peakRssBytes / 1e9).toFixed(2)}GB`);
    clearInterval(rssSampler);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 1. Ingest 3 decks, pool them (verified in MISAEL_PROTOCOL.md: no cardId
//    collision across decks).
// ---------------------------------------------------------------------------

const files = (await readdir(DIR)).filter((f) => f.endsWith(".apkg")).sort();
console.log(`baralhos: ${files.join(", ")}`);

const allReviews: Review[] = [];
const allCards = new Map<number, NormalizedCard>();
const deckByCard = new Map<number, string>();
const notetypeByCard = new Map<number, number>();

for (const file of files) {
  const { collection, reviews } = await ingestApkgFile(`${DIR}/${file}`);
  const normalized = buildNormalizedCards(collection);
  const reviewedCardIds = new Set(reviews.map((r) => r.cardId));
  const notesById = new Map(collection.notes.map((n) => [n.id, n]));

  for (const c of normalized) {
    if (c.contentless || !reviewedCardIds.has(c.cardId)) continue;
    allCards.set(c.cardId, c);
    deckByCard.set(c.cardId, file);
    notetypeByCard.set(c.cardId, notesById.get(c.noteId)?.modelId ?? -1);
  }
  allReviews.push(...reviews);
}

console.log(`cartões elegíveis (pooled, com conteúdo e >=1 revisão): ${allCards.size}`);
console.log(`revisões mantidas (pooled): ${allReviews.length}`);
console.log(`notetypes distintos: ${new Set(notetypeByCard.values()).size}`);

// ---------------------------------------------------------------------------
// 2. Split 70/30, FSRS otimizado só no treino, replay combinado.
// ---------------------------------------------------------------------------

const { train, test } = splitChronological(allReviews);
const cutoffId = test[0]?.id ?? Infinity;

const opt = await optimizeParameters(train);
console.log(`FSRS otimização: ${opt.fallbackReason ? `fallback (${opt.fallbackReason})` : "ok"}`);
console.log(`  parâmetros padrão:    [${opt.defaultParameters.map((w) => w.toFixed(4)).join(", ")}]`);
console.log(`  parâmetros otimizados:${opt.optimizedParameters ? ` [${opt.optimizedParameters.map((w) => w.toFixed(4)).join(", ")}]` : " (não disponível, usando padrão)"}`);
if (opt.optimizedParameters) {
  const maxAbsDiff = Math.max(...opt.optimizedParameters.map((w, i) => Math.abs(w - opt.defaultParameters[i]!)));
  console.log(`  maior diferença absoluta padrão vs otimizado: ${maxAbsDiff.toFixed(4)} (0 significaria "otimização não mudou nada")`);
}
const fsrsAlgo = new FSRSAlgorithm(generatorParameters({ w: opt.optimizedParameters ?? opt.defaultParameters }));
const replayed: ReplayedReview[] = replayAll(fsrsAlgo, allReviews);
checkMemory("after FSRS replay");

interface EligibleReview {
  cardId: number;
  predictedR: number;
  label: 0 | 1;
  day: number;
  isTrainPeriod: boolean;
  /** train-period AND includedInEval (>=1 day gap) — matches the English.apkg
   * ablation's grid-search scoring population. `isTrainPeriod` alone (below)
   * previously drove grid-search scoring here too, which was a bug: it let
   * same-day repeats into the score used to pick hyperparameters, unlike the
   * registered protocol. Fixed after a preliminary result surfaced it — see
   * MISAEL_PROTOCOL.md amendment. */
  isTrainEval: boolean;
  isTestEval: boolean;
}

const eligible: EligibleReview[] = [];
for (const r of replayed) {
  if (r.predictedR === null) continue;
  const isTrainPeriod = r.reviewId < cutoffId;
  eligible.push({
    cardId: r.cardId,
    predictedR: r.predictedR,
    label: r.label,
    day: Math.floor(r.reviewId / DAY_MS),
    isTrainPeriod,
    isTrainEval: isTrainPeriod && r.includedInEval,
    isTestEval: !isTrainPeriod && r.includedInEval,
  });
}
console.log(`revisões elegíveis (predictedR != null): ${eligible.length}`);

function evalFsrs(period: "train" | "test"): ScoredReview[] {
  const out: ScoredReview[] = [];
  for (const r of eligible) {
    if (period === "train" ? !r.isTrainEval : !r.isTestEval) continue;
    out.push({ cardId: r.cardId, p: r.predictedR, y: r.label });
  }
  return out;
}
const fsrsPreds = evalFsrs("test");
const fsrsTrainPreds = evalFsrs("train");

console.log(`\nFSRS otimizado (treino, espaçadas >=1 dia): n=${fsrsTrainPreds.length} logLoss=${logLoss(fsrsTrainPreds).toFixed(4)}`);
const constantTrainPreds = constantBaselinePredictions(
  fsrsTrainPreds.map((p) => p.y),
  fsrsTrainPreds,
);
const constantTestPreds = constantBaselinePredictions(
  fsrsTrainPreds.map((p) => p.y),
  fsrsPreds,
);
console.log(`Constante (taxa do treino=${(constantTrainPreds[0]?.p ?? NaN).toFixed(4)}):`);
console.log(`  treino: logLoss=${logLoss(constantTrainPreds).toFixed(4)}`);
console.log(`  teste:  logLoss=${logLoss(constantTestPreds).toFixed(4)}`);
if (logLoss(fsrsTrainPreds) > logLoss(constantTrainPreds)) {
  console.log(`  ATENÇÃO: FSRS perde para a constante no TREINO (${logLoss(fsrsTrainPreds).toFixed(4)} > ${logLoss(constantTrainPreds).toFixed(4)}) — investigar antes de prosseguir.`);
}
if (logLoss(fsrsPreds) > logLoss(constantTestPreds)) {
  console.log(`  ATENÇÃO: FSRS perde para a constante no TESTE (${logLoss(fsrsPreds).toFixed(4)} > ${logLoss(constantTestPreds).toFixed(4)}) — investigar antes de prosseguir.`);
}
console.log(`\nFSRS otimizado (teste, espaçadas >=1 dia): n=${fsrsPreds.length} logLoss=${logLoss(fsrsPreds).toFixed(4)} AUC=${auc(fsrsPreds).toFixed(4)}`);

// ---------------------------------------------------------------------------
// 3. Concept-style variants (main, deck-node, notetype-node, global-node)
// ---------------------------------------------------------------------------

const mainConceptsByCard = new Map<number, string[]>();
const deckConceptsByCard = new Map<number, string[]>();
const notetypeConceptsByCard = new Map<number, string[]>();
const globalConceptsByCard = new Map<number, string[]>();

for (const [cardId, card] of allCards) {
  const vocab = extractVocabularyConcepts(card.text, { excludeFunctionWords: true, functionWords: PORTUGUESE_FUNCTION_WORDS }).map((v) => v.name);
  const deckLabel = `deck:${deckByCard.get(cardId)}`;
  mainConceptsByCard.set(cardId, vocab);
  deckConceptsByCard.set(cardId, [deckLabel]);
  notetypeConceptsByCard.set(cardId, [`notetype:${notetypeByCard.get(cardId)}`]);
  globalConceptsByCard.set(cardId, ["__GLOBAL__"]);
}

interface ConceptHp { priorVariance: number; driftPerDay: number; lambda: number }

/** Log-loss only, no array allocation — used by grid search and permutation (the hot path). Verified equivalent to array+logLoss() (bit-exact on a synthetic case) before this redesign was run. */
function scoreConceptLogLoss(conceptsByCard: ReadonlyMap<number, string[]>, hp: ConceptHp, trainOnly: boolean): number {
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  let sum = 0;
  let count = 0;
  for (const r of eligible) {
    if (trainOnly && !r.isTrainPeriod) break; // eligible is chronologically ordered
    const included = trainOnly ? r.isTrainEval : r.isTestEval;
    const names = conceptsByCard.get(r.cardId);
    // Weight normalized by concept count (average, not sum) — a card with
    // many distinct vocabulary words no longer gets a proportionally larger
    // log-odds shift than a card with one; fixes a saturation bug found in
    // a preliminary run (predictions hitting exactly 0/1). See
    // MISAEL_PROTOCOL.md amendment.
    const links: WeightedLink<string>[] =
      names && names.length > 0 ? names.map((name) => ({ id: name, weight: hp.lambda / names.length })) : [];
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (included) {
      const clamped = Math.min(1 - 1e-4, Math.max(1e-4, p));
      sum += r.label === 1 ? -Math.log(clamped) : -Math.log(1 - clamped);
      count++;
    }
  }
  return count > 0 ? sum / count : NaN;
}

/** Array-returning version — used ONCE per variant (final evaluation), not in grid search/permutation. */
function evalConceptModel(conceptsByCard: ReadonlyMap<number, string[]>, hp: ConceptHp): ScoredReview[] {
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  const out: ScoredReview[] = [];
  for (const r of eligible) {
    const names = conceptsByCard.get(r.cardId);
    const links: WeightedLink<string>[] =
      names && names.length > 0 ? names.map((name) => ({ id: name, weight: hp.lambda / names.length })) : [];
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (r.isTestEval) out.push({ cardId: r.cardId, p, y: r.label });
  }
  return out;
}

const PRIOR_VARIANCE_GRID = [0.25, 1];
const DRIFT_PER_DAY_GRID = [0.001, 0.01];
const LAMBDA_GRID = [0, 0.25, 0.5, 1, 2];

function conceptGridSearch(conceptsByCard: ReadonlyMap<number, string[]>): { best: ConceptHp; trainLogLoss: number } {
  let best: ConceptHp | null = null;
  let bestLoss = Infinity;
  for (const priorVariance of PRIOR_VARIANCE_GRID) {
    for (const driftPerDay of DRIFT_PER_DAY_GRID) {
      for (const lambda of LAMBDA_GRID) {
        const hp = { priorVariance, driftPerDay, lambda };
        const loss = scoreConceptLogLoss(conceptsByCard, hp, true);
        if (loss < bestLoss) { bestLoss = loss; best = hp; }
      }
    }
  }
  return { best: best!, trainLogLoss: bestLoss };
}

// ---------------------------------------------------------------------------
// 4. Run all variants, report metrics + bootstrap.
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(78)}\nVariantes\n${"=".repeat(78)}`);

const mainGrid = conceptGridSearch(mainConceptsByCard);
const mainTest = evalConceptModel(mainConceptsByCard, mainGrid.best);
console.log(`\n1. Variante principal (vocabulário PT sem funcionais, frente+verso)`);
console.log(`   grid: ${JSON.stringify(mainGrid.best)} trainLogLoss=${mainGrid.trainLogLoss.toFixed(4)}`);
console.log(`   teste: n=${mainTest.length} logLoss=${logLoss(mainTest).toFixed(4)} AUC=${auc(mainTest).toFixed(4)}`);
const bootMain = bootstrapLogLossDelta(fsrsPreds, mainTest, { iterations: 3000, seed: 42 });
console.log(`   FSRS vs principal: Δ=${bootMain.meanDelta.toFixed(4)} CI95=[${bootMain.ci95[0].toFixed(4)}, ${bootMain.ci95[1].toFixed(4)}]`);
checkMemory("after main variant");

const deckGrid = conceptGridSearch(deckConceptsByCard);
const deckTest = evalConceptModel(deckConceptsByCard, deckGrid.best);
console.log(`\n2. Controle: nó por baralho`);
console.log(`   grid: ${JSON.stringify(deckGrid.best)} trainLogLoss=${deckGrid.trainLogLoss.toFixed(4)}`);
console.log(`   teste: n=${deckTest.length} logLoss=${logLoss(deckTest).toFixed(4)} AUC=${auc(deckTest).toFixed(4)}`);
const bootDeck = bootstrapLogLossDelta(fsrsPreds, deckTest, { iterations: 3000, seed: 42 });
console.log(`   FSRS vs deck: Δ=${bootDeck.meanDelta.toFixed(4)} CI95=[${bootDeck.ci95[0].toFixed(4)}, ${bootDeck.ci95[1].toFixed(4)}]`);
const mainVsDeck = bootstrapLogLossDelta(deckTest, mainTest, { iterations: 3000, seed: 42 });
console.log(`   principal vs deck: Δ=${mainVsDeck.meanDelta.toFixed(4)} CI95=[${mainVsDeck.ci95[0].toFixed(4)}, ${mainVsDeck.ci95[1].toFixed(4)}]`);
checkMemory("after deck control");

const notetypeGrid = conceptGridSearch(notetypeConceptsByCard);
const notetypeTest = evalConceptModel(notetypeConceptsByCard, notetypeGrid.best);
console.log(`\n3. Controle: nó por notetype (esperado idêntico ao nó global — ver MISAEL_PROTOCOL.md)`);
console.log(`   grid: ${JSON.stringify(notetypeGrid.best)} trainLogLoss=${notetypeGrid.trainLogLoss.toFixed(4)}`);
console.log(`   teste: n=${notetypeTest.length} logLoss=${logLoss(notetypeTest).toFixed(4)} AUC=${auc(notetypeTest).toFixed(4)}`);
const bootNotetype = bootstrapLogLossDelta(fsrsPreds, notetypeTest, { iterations: 3000, seed: 42 });
console.log(`   FSRS vs notetype: Δ=${bootNotetype.meanDelta.toFixed(4)} CI95=[${bootNotetype.ci95[0].toFixed(4)}, ${bootNotetype.ci95[1].toFixed(4)}]`);
const mainVsNotetype = bootstrapLogLossDelta(notetypeTest, mainTest, { iterations: 3000, seed: 42 });
console.log(`   principal vs notetype: Δ=${mainVsNotetype.meanDelta.toFixed(4)} CI95=[${mainVsNotetype.ci95[0].toFixed(4)}, ${mainVsNotetype.ci95[1].toFixed(4)}]`);
checkMemory("after notetype control");

const globalGrid = conceptGridSearch(globalConceptsByCard);
const globalTest = evalConceptModel(globalConceptsByCard, globalGrid.best);
console.log(`\n4. Controle: nó global único`);
console.log(`   grid: ${JSON.stringify(globalGrid.best)} trainLogLoss=${globalGrid.trainLogLoss.toFixed(4)}`);
console.log(`   teste: n=${globalTest.length} logLoss=${logLoss(globalTest).toFixed(4)} AUC=${auc(globalTest).toFixed(4)}`);
const bootGlobal = bootstrapLogLossDelta(fsrsPreds, globalTest, { iterations: 3000, seed: 42 });
console.log(`   FSRS vs global: Δ=${bootGlobal.meanDelta.toFixed(4)} CI95=[${bootGlobal.ci95[0].toFixed(4)}, ${bootGlobal.ci95[1].toFixed(4)}]`);
checkMemory("after global control");

// ---------------------------------------------------------------------------
// 4b. AMENDMENT (post-hoc, see MISAEL_PROTOCOL.md): new base = FSRS+deck
//     (deckTest, above); new variant = FSRS+deck+vocabulary, with SEPARATE
//     lambdas for the deck link and the vocabulary links (fixed after a
//     preliminary run used a single shared lambda for both — see report).
// ---------------------------------------------------------------------------

interface CombinedHp { priorVariance: number; driftPerDay: number; lambdaDeck: number; lambdaVocab: number }

// Cards absent from deckByCard are contentless/excluded (not in allCards) —
// every other variant (main/deck/notetype/global) falls back to raw FSRS
// (no links) for such cards via `names ?? []` -> empty links. A preliminary
// run found this function DIDN'T: it always attached a deck link (as
// "deck:undefined" for these cards), so with lambdaVocab=0 it still
// differed from the standalone deck model by ~0.44 on some predictions.
// Fixed by returning no links at all when the card has no deck assignment,
// matching every other variant's fallback exactly.
function combinedLinks(cardId: number, hp: CombinedHp, vocabByCard: ReadonlyMap<number, string[]>): WeightedLink<string>[] {
  const deck = deckByCard.get(cardId);
  if (deck === undefined) return [];
  const vocab = vocabByCard.get(cardId) ?? [];
  const links: WeightedLink<string>[] = [{ id: `deck:${deck}`, weight: hp.lambdaDeck }];
  for (const name of vocab) links.push({ id: name, weight: hp.lambdaVocab / vocab.length });
  return links;
}

function scoreCombinedLogLoss(hp: CombinedHp, trainOnly: boolean, vocabByCard: ReadonlyMap<number, string[]> = mainConceptsByCard): number {
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  let sum = 0;
  let count = 0;
  for (const r of eligible) {
    if (trainOnly && !r.isTrainPeriod) break;
    const included = trainOnly ? r.isTrainEval : r.isTestEval;
    const links = combinedLinks(r.cardId, hp, vocabByCard);
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (included) {
      const clamped = Math.min(1 - 1e-4, Math.max(1e-4, p));
      sum += r.label === 1 ? -Math.log(clamped) : -Math.log(1 - clamped);
      count++;
    }
  }
  return count > 0 ? sum / count : NaN;
}

function evalCombinedModel(hp: CombinedHp, vocabByCard: ReadonlyMap<number, string[]> = mainConceptsByCard): ScoredReview[] {
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  const out: ScoredReview[] = [];
  for (const r of eligible) {
    const links = combinedLinks(r.cardId, hp, vocabByCard);
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, r.day) : r.predictedR;
    if (r.isTestEval) out.push({ cardId: r.cardId, p, y: r.label });
  }
  return out;
}

function combinedGridSearch(vocabByCard: ReadonlyMap<number, string[]> = mainConceptsByCard): { best: CombinedHp; trainLogLoss: number } {
  let best: CombinedHp | null = null;
  let bestLoss = Infinity;
  for (const priorVariance of PRIOR_VARIANCE_GRID) {
    for (const driftPerDay of DRIFT_PER_DAY_GRID) {
      for (const lambdaDeck of LAMBDA_GRID) {
        for (const lambdaVocab of LAMBDA_GRID) {
          const hp = { priorVariance, driftPerDay, lambdaDeck, lambdaVocab };
          const loss = scoreCombinedLogLoss(hp, true, vocabByCard);
          if (loss < bestLoss) { bestLoss = loss; best = hp; }
        }
      }
    }
  }
  return { best: best!, trainLogLoss: bestLoss };
}

const combinedGrid = combinedGridSearch();
const combinedTest = evalCombinedModel(combinedGrid.best);
console.log(`\n5. [EMENDA] Variante: FSRS + nó por baralho + vocabulário (λ separados)`);
console.log(`   grid: ${JSON.stringify(combinedGrid.best)} trainLogLoss=${combinedGrid.trainLogLoss.toFixed(4)}`);
console.log(`   teste: n=${combinedTest.length} logLoss=${logLoss(combinedTest).toFixed(4)} AUC=${auc(combinedTest).toFixed(4)}`);
const bootCombinedVsFsrs = bootstrapLogLossDelta(fsrsPreds, combinedTest, { iterations: 3000, seed: 42 });
console.log(`   FSRS vs combinada: Δ=${bootCombinedVsFsrs.meanDelta.toFixed(4)} CI95=[${bootCombinedVsFsrs.ci95[0].toFixed(4)}, ${bootCombinedVsFsrs.ci95[1].toFixed(4)}]`);
const bootCombinedVsDeckBase = bootstrapLogLossDelta(deckTest, combinedTest, { iterations: 3000, seed: 42 });
console.log(`   [NOVA BASE] deck (FSRS+deck) vs combinada: Δ=${bootCombinedVsDeckBase.meanDelta.toFixed(4)} CI95=[${bootCombinedVsDeckBase.ci95[0].toFixed(4)}, ${bootCombinedVsDeckBase.ci95[1].toFixed(4)}]`);
checkMemory("after combined variant");

// --- Diagnóstico pedido: λ_vocab=0 forçado (mesmos priorVariance/driftPerDay/lambdaDeck do controle "deck" sozinho) deve reproduzir deckTest exatamente ---
console.log(`\n   [diagnóstico] com λ_vocab=0 e os mesmos hiperparâmetros do controle "deck" sozinho:`);
const forcedZeroVocabHp: CombinedHp = { priorVariance: deckGrid.best.priorVariance, driftPerDay: deckGrid.best.driftPerDay, lambdaDeck: deckGrid.best.lambda, lambdaVocab: 0 };
const combinedTestZeroVocab = evalCombinedModel(forcedZeroVocabHp);
console.log(`   logLoss(λ_vocab=0)=${logLoss(combinedTestZeroVocab).toFixed(10)} vs logLoss(deck sozinho)=${logLoss(deckTest).toFixed(10)}`);
let maxDiagDiff = 0;
for (let i = 0; i < deckTest.length; i++) maxDiagDiff = Math.max(maxDiagDiff, Math.abs(deckTest[i]!.p - combinedTestZeroVocab[i]!.p));
console.log(`   maior diferença ponto-a-ponto: ${maxDiagDiff} ${maxDiagDiff < 1e-12 ? "(idêntico, OK)" : "(DIFERENTE — investigar)"}`);

// --- Diagnóstico pedido: log-loss no treino, variante (nos hiperparâmetros escolhidos) vs base ---
const combinedTrainAtBest = scoreCombinedLogLoss(combinedGrid.best, true);
console.log(`\n   [diagnóstico] log-loss no TREINO: base(deck)=${deckGrid.trainLogLoss.toFixed(4)} variante(combinada)=${combinedTrainAtBest.toFixed(4)}`);

// --- Diagnóstico pedido: distribuição das previsões no teste ---
function predStats(preds: ScoredReview[]): { min: number; mean: number; max: number } {
  const ps = preds.map((p) => p.p);
  return { min: Math.min(...ps), mean: ps.reduce((a, b) => a + b, 0) / ps.length, max: Math.max(...ps) };
}
const deckStats = predStats(deckTest);
const combinedStats = predStats(combinedTest);
console.log(`\n   [diagnóstico] distribuição das previsões no teste:`);
console.log(`   base (deck):     min=${deckStats.min.toFixed(4)} média=${deckStats.mean.toFixed(4)} máx=${deckStats.max.toFixed(4)}`);
console.log(`   variante (comb): min=${combinedStats.min.toFixed(4)} média=${combinedStats.mean.toFixed(4)} máx=${combinedStats.max.toFixed(4)}`);

// ---------------------------------------------------------------------------
// 5. Permutation — main, deck, notetype. Skips global (uniform assignment;
//    shuffling it is a no-op, same rationale as English/KARL). Embedding
//    variant's permutation is deferred until scripts/embed-misael.mts has
//    been run and approved.
// ---------------------------------------------------------------------------

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
function shuffleByCard<T>(byCard: ReadonlyMap<number, T>, seed: number): Map<number, T> {
  const cardIds = [...byCard.keys()];
  const values = cardIds.map((id) => byCard.get(id)!);
  const shuffled = seededShuffle(values, seed);
  const result = new Map<number, T>();
  cardIds.forEach((id, i) => result.set(id, shuffled[i]!));
  return result;
}

function permutationTest(label: string, realLogLoss: number, runOnce: (seed: number) => number, iterations: number): number {
  if (iterations <= 0) {
    console.log(`${label}: permutação pulada (MISAEL_PERMUTATIONS=0 — só relatório, sem rodar o protocolo)`);
    return NaN;
  }
  const shuffleLosses: number[] = [];
  console.time(label);
  for (let seed = 1; seed <= iterations; seed++) {
    shuffleLosses.push(runOnce(seed * 1000 + 7));
    if (seed % 5 === 0 || seed === iterations) {
      console.log(`  ${label}: ${seed}/${iterations} (RSS=${(process.memoryUsage().rss / 1e9).toFixed(2)}GB)`);
      checkMemory(`${label} permutation ${seed}`);
    }
  }
  console.timeEnd(label);
  const beatOrTied = shuffleLosses.filter((l) => l <= realLogLoss).length;
  const p = (beatOrTied + 1) / (shuffleLosses.length + 1);
  const mean = shuffleLosses.reduce((s, l) => s + l, 0) / shuffleLosses.length;
  console.log(`${label}: real=${realLogLoss.toFixed(4)} média_embaralhada=${mean.toFixed(4)} p empírico≈${p.toFixed(4)} (${beatOrTied}/${iterations} <= real)`);
  return p;
}

console.log(`\n${"=".repeat(78)}\nPermutação (${PERMUTATIONS}x)\n${"=".repeat(78)}`);

const pMain = permutationTest("principal", logLoss(mainTest), (seed) => {
  const shuffled = shuffleByCard(mainConceptsByCard, seed);
  const grid = conceptGridSearch(shuffled);
  return scoreConceptLogLoss(shuffled, grid.best, false);
}, PERMUTATIONS);

const pDeck = permutationTest("deck", logLoss(deckTest), (seed) => {
  const shuffled = shuffleByCard(deckConceptsByCard, seed);
  const grid = conceptGridSearch(shuffled);
  return scoreConceptLogLoss(shuffled, grid.best, false);
}, PERMUTATIONS);

const pNotetype = permutationTest("notetype", logLoss(notetypeTest), (seed) => {
  const shuffled = shuffleByCard(notetypeConceptsByCard, seed);
  const grid = conceptGridSearch(shuffled);
  return scoreConceptLogLoss(shuffled, grid.best, false);
}, PERMUTATIONS);

// [EMENDA] Combined variant's permutation: shuffle ONLY the vocabulary
// assignment across cards; each card's deck label stays fixed (its own,
// unshuffled) — per MISAEL_PROTOCOL.md's amendment. Re-runs the full 4D
// (priorVariance, driftPerDay, lambdaDeck, lambdaVocab) grid search per
// permutation, on the shuffled vocab map.
function shuffleVocabOnly(seed: number): Map<number, string[]> {
  const cardIds = [...allCards.keys()];
  const vocabLists = cardIds.map((id) => mainConceptsByCard.get(id)!);
  const shuffledVocab = seededShuffle(vocabLists, seed);
  const result = new Map<number, string[]>();
  cardIds.forEach((id, i) => result.set(id, shuffledVocab[i]!));
  return result;
}
const pCombined = permutationTest("combinada (só vocabulário embaralhado, deck fixo)", logLoss(combinedTest), (seed) => {
  const shuffledVocab = shuffleVocabOnly(seed);
  const grid = combinedGridSearch(shuffledVocab);
  return scoreCombinedLogLoss(grid.best, false, shuffledVocab);
}, PERMUTATIONS);

console.log(`\npermutação: nó global único — pulada (atribuição uniforme, embaralhar não muda nada)`);
console.log(`permutação: vizinhos por embedding — adiada até embed-misael.mts rodar e ser aprovado`);

// ---------------------------------------------------------------------------
// 6. Per-deck breakdown (supplementary)
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(78)}\nRelato suplementar: por baralho\n${"=".repeat(78)}`);
for (const file of files) {
  const cardsInDeck = new Set([...allCards.keys()].filter((id) => deckByCard.get(id) === file));
  const fsrsDeck = fsrsPreds.filter((p) => cardsInDeck.has(p.cardId));
  const mainDeck = mainTest.filter((p) => cardsInDeck.has(p.cardId));
  console.log(`\n${file}`);
  console.log(`  n(teste espaçado)=${fsrsDeck.length}`);
  console.log(`  FSRS: logLoss=${logLoss(fsrsDeck).toFixed(4)} AUC=${auc(fsrsDeck).toFixed(4)}`);
  console.log(`  principal: logLoss=${logLoss(mainDeck).toFixed(4)} AUC=${auc(mainDeck).toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// 7. Partial status (full success criterion needs the embedding variant too)
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(78)}\n[EMENDA] Critério de sucesso: combinada (FSRS+deck+vocab) vs base (FSRS+deck)\n${"=".repeat(78)}`);
function ciFavorsComparison(ci: [number, number]): boolean {
  return ci[0] > 0;
}
const combinedBeatsBase = ciFavorsComparison(bootCombinedVsDeckBase.ci95);
console.log(`combinada vence a nova base (FSRS+deck)? IC95%=[${bootCombinedVsDeckBase.ci95[0].toFixed(4)}, ${bootCombinedVsDeckBase.ci95[1].toFixed(4)}] entirely favorable? ${combinedBeatsBase}`);
console.log(`permutação (só vocabulário, deck fixo) p<0.05? ${pCombined < 0.05} (p=${pCombined.toFixed(4)})`);
const amendedSuccess = combinedBeatsBase && pCombined < 0.05;
console.log(`\nSUCESSO (critério emendado)? ${amendedSuccess}`);

console.log(`\n--- Informação suplementar (não faz mais parte do critério de sucesso) ---`);
const beatsFsrs = ciFavorsComparison(bootMain.ci95);
const beatsDeck = ciFavorsComparison(mainVsDeck.ci95);
const beatsNotetype = ciFavorsComparison(mainVsNotetype.ci95);
console.log(`principal sozinha vence FSRS (IC>0)? ${beatsFsrs}`);
console.log(`principal sozinha vence nó por baralho (IC>0)? ${beatsDeck}`);
console.log(`principal sozinha vence nó por notetype (IC>0)? ${beatsNotetype}`);
console.log(`permutação principal sozinha p<0.05? ${pMain < 0.05} (p=${pMain.toFixed(4)})`);
console.log(`(variante de embedding ainda pendente de embed-misael.mts)`);

console.log(`\nPico de RSS observado: ${(peakRssBytes / 1e9).toFixed(2)}GB`);
clearInterval(rssSampler);
console.timeEnd("total");
