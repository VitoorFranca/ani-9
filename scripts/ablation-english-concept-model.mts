process.loadEnvFile(".env");
import { readFileSync, existsSync } from "node:fs";
import { ingestApkgFile } from "../src/ingest/index.ts";
import { buildNormalizedCards } from "../src/content/build.ts";
import { splitChronological, optimizeParameters, replayAll } from "../src/fsrs/index.ts";
import { FSRSAlgorithm, generatorParameters } from "ts-fsrs";
import { extractVocabularyConcepts } from "../src/concepts/vocabulary.ts";
import { tokenize } from "../src/model/bm25.ts";
import { GraphBayesianModel } from "../src/model/bayesian.ts";
import { computeConceptNoteCoverage, sameNoteOnlyConcepts } from "../src/model/concept-coverage.ts";
import {
  logLoss, auc, calibrationRmse, bootstrapLogLossDelta,
  type ScoredReview,
} from "../src/eval/metrics.ts";
import type { ReplayedReview } from "../src/fsrs/replay.ts";
import type { WeightedLink } from "../src/model/bayesian.ts";

const DAY_MS = 86_400_000;
console.time("total");

const CACHE_PATH = "./cache/classify-english-fixed-list.json";
if (!existsSync(CACHE_PATH)) {
  throw new Error(`Cache não encontrado em ${CACHE_PATH} — rode scripts/analyze-english-concept-model.mts primeiro (esta ablação não faz chamadas de API).`);
}
const listConceptsByCard = new Map<number, string[]>(JSON.parse(readFileSync(CACHE_PATH, "utf8")) as [number, string[]][]);

// --- Ingest + FSRS baseline (idêntico ao relatório principal) ---
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

function evalFsrsCut(fromTrain: boolean): ScoredReview[] {
  const out: ScoredReview[] = [];
  for (const r of replayed) {
    const isTrainPeriod = r.reviewId < cutoffId;
    if (fromTrain !== isTrainPeriod) continue;
    if (!r.includedInEval || r.predictedR === null) continue;
    out.push({ cardId: r.cardId, p: r.predictedR, y: r.label });
  }
  return out;
}
const fsrsTestPreds = evalFsrsCut(false);

// --- Recorte "cross-note" FIXO, definido pelo modelo completo (lista + vocabulário COM palavras funcionais) ---
// Mantido igual ao relatório principal para comparabilidade direta.
const fullConceptsByCard = new Map<number, string[]>();
for (const c of eligible) {
  const vocab = extractVocabularyConcepts(c.front).map(v => v.name);
  fullConceptsByCard.set(c.cardId, [...(listConceptsByCard.get(c.cardId) ?? []), ...vocab]);
}
const fullNoteCoverage = computeConceptNoteCoverage(fullConceptsByCard, noteIdByCard);
const fullSameNoteOnly = sameNoteOnlyConcepts(fullNoteCoverage);
const fullCrossNoteConcepts = new Set([...fullNoteCoverage.keys()].filter(c => !fullSameNoteOnly.has(c)));
const FIXED_CROSS_NOTE_CARDS = new Set(
  eligible.filter(c => (fullConceptsByCard.get(c.cardId) ?? []).some(name => fullCrossNoteConcepts.has(name))).map(c => c.cardId)
);
console.log(`recorte cross-note fixo (definido pelo modelo completo): ${FIXED_CROSS_NOTE_CARDS.size} / ${eligible.length} cartões`);

const fsrsCross = fsrsTestPreds.filter(p => FIXED_CROSS_NOTE_CARDS.has(p.cardId));

// --- Infra do modelo (idêntica ao relatório principal) ---
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
function shuffleConceptsByCard(conceptsByCard: Map<number, string[]>, seed: number): Map<number, string[]> {
  const cardIds = [...conceptsByCard.keys()];
  const lists = cardIds.map(id => conceptsByCard.get(id)!);
  const shuffledLists = seededShuffle(lists, seed);
  const result = new Map<number, string[]>();
  cardIds.forEach((id, i) => result.set(id, shuffledLists[i]!));
  return result;
}

// --- Definição das 4 variantes ---
type Variant = { label: string; conceptsByCard: Map<number, string[]> };

const onlyList: Map<number, string[]> = new Map(eligible.map(c => [c.cardId, listConceptsByCard.get(c.cardId) ?? []]));
const onlyVocab: Map<number, string[]> = new Map(eligible.map(c => [c.cardId, extractVocabularyConcepts(c.front).map(v => v.name)]));
const onlyVocabNoFunction: Map<number, string[]> = new Map(eligible.map(c => [c.cardId, extractVocabularyConcepts(c.front, { excludeFunctionWords: true }).map(v => v.name)]));
const listPlusVocabNoFunction: Map<number, string[]> = new Map(eligible.map(c => [
  c.cardId,
  [...(listConceptsByCard.get(c.cardId) ?? []), ...extractVocabularyConcepts(c.front, { excludeFunctionWords: true }).map(v => v.name)],
]));

// Controle: um único nó artificial compartilhado por TODO cartão elegível —
// testa se o sucesso do vocabulário é recalibração global variável no tempo
// (via driftPerDay) em vez de transferência de conteúdo real. Permutar a
// atribuição não faz sentido aqui (todo cartão tem a mesma lista de 1 item;
// qualquer "embaralhamento" produz o modelo idêntico), então o teste de
// permutação é pulado para esta variante, com uma nota explícita.
const singleGlobalNode: Map<number, string[]> = new Map(eligible.map(c => [c.cardId, ["__GLOBAL__"]]));

// Controle: um nó por notetype — testa se o efeito do vocabulário é só
// "que categoria ampla de cartão é esta" (frase vs. palavra isolada) em vez
// de conteúdo lexical específico.
const notesById = new Map(collection.notes.map(n => [n.id, n]));
const modelIdByCard = new Map(eligible.map(c => [c.cardId, notesById.get(c.noteId)?.modelId]));
const notetypeNode: Map<number, string[]> = new Map(eligible.map(c => [c.cardId, [`notetype:${modelIdByCard.get(c.cardId) ?? "?"}`]]));

// Controle: um nó por faixa de tamanho do front (1 palavra / 2-4 / 5+) —
// mesma lógica: cartões curtos (vocabulário isolado) e longos (frases) têm
// perfis de dificuldade muito diferentes; isso testa se É SÓ ISSO que o
// vocabulário está capturando.
function lengthBucket(front: string): string {
  const n = tokenize(front).length;
  if (n <= 1) return "1 palavra";
  if (n <= 4) return "2-4 palavras";
  return "5+ palavras";
}
const lengthBucketNode: Map<number, string[]> = new Map(eligible.map(c => [c.cardId, [`tamanho:${lengthBucket(c.front)}`]]));

const variants: (Variant & { skipPermutation?: boolean })[] = [
  { label: "1. Só lista fixa (22 conceitos)", conceptsByCard: onlyList },
  { label: "2. Só vocabulário", conceptsByCard: onlyVocab },
  { label: "3. Vocabulário sem palavras funcionais", conceptsByCard: onlyVocabNoFunction },
  { label: "4. Lista fixa + vocabulário sem palavras funcionais", conceptsByCard: listPlusVocabNoFunction },
  { label: "5. Controle: nó global único (todo cartão)", conceptsByCard: singleGlobalNode, skipPermutation: true },
  { label: "6. Controle: nó por notetype", conceptsByCard: notetypeNode },
  { label: "7. Controle: nó por faixa de tamanho do cartão", conceptsByCard: lengthBucketNode },
];

const PERMUTATIONS = 1000;

for (const variant of variants) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(variant.label);
  console.log("=".repeat(70));

  // Cobertura
  const cardsWithAnyConcept = eligible.filter(c => (variant.conceptsByCard.get(c.cardId) ?? []).length > 0).length;
  const cardsWithAnyConceptInCrossNoteCut = eligible.filter(c => FIXED_CROSS_NOTE_CARDS.has(c.cardId) && (variant.conceptsByCard.get(c.cardId) ?? []).length > 0).length;
  console.log(`cobertura: ${cardsWithAnyConcept}/${eligible.length} cartões elegíveis têm >=1 conceito nesta variante`);
  console.log(`           ${cardsWithAnyConceptInCrossNoteCut}/${FIXED_CROSS_NOTE_CARDS.size} cartões do recorte cross-note têm >=1 conceito nesta variante`);

  // Grid search + avaliação no recorte fixo
  const grid = jointGridSearch(variant.conceptsByCard);
  console.log(`grid search (treino): best hp=${JSON.stringify(grid.best)}, train logLoss=${grid.logLoss.toFixed(4)}`);

  const testPreds = runConceptModel(variant.conceptsByCard, grid.best, false);
  const testCross = testPreds.filter(p => FIXED_CROSS_NOTE_CARDS.has(p.cardId));
  console.log(`teste (recorte cross-note, n=${testCross.length}): logLoss=${logLoss(testCross).toFixed(4)} AUC=${auc(testCross).toFixed(4)} calibRMSE=${calibrationRmse(testCross, 10).toFixed(4)}`);
  console.log(`FSRS otimizado no mesmo recorte: logLoss=${logLoss(fsrsCross).toFixed(4)} AUC=${auc(fsrsCross).toFixed(4)}`);

  // Bootstrap
  if (fsrsCross.length === testCross.length) {
    const boot = bootstrapLogLossDelta(fsrsCross, testCross, { iterations: 3000, seed: 42 });
    console.log(`bootstrap FSRS vs variante: Δ=${boot.meanDelta.toFixed(4)} CI95=[${boot.ci95[0].toFixed(4)}, ${boot.ci95[1].toFixed(4)}]`);
  }

  // 1000 permutações, cada uma refazendo a busca em grade
  if (variant.skipPermutation) {
    console.log(`permutação: pulada (todo cartão tem a mesma lista de 1 item; embaralhar não muda nada)`);
  } else {
    const realLoss = logLoss(testCross);
    const shuffleLosses: number[] = [];
    for (let seed = 1; seed <= PERMUTATIONS; seed++) {
      const shuffled = shuffleConceptsByCard(variant.conceptsByCard, seed * 1000 + 7);
      const shuffleGrid = jointGridSearch(shuffled);
      const shuffledPreds = runConceptModel(shuffled, shuffleGrid.best, false);
      const shuffledCross = shuffledPreds.filter(p => FIXED_CROSS_NOTE_CARDS.has(p.cardId));
      shuffleLosses.push(logLoss(shuffledCross));
    }
    const meanShuffled = shuffleLosses.reduce((s, l) => s + l, 0) / shuffleLosses.length;
    const beatOrTied = shuffleLosses.filter(l => l <= realLoss).length;
    const pValue = (beatOrTied + 1) / (shuffleLosses.length + 1);
    console.log(`permutação (${PERMUTATIONS}x, refazendo grid): real=${realLoss.toFixed(4)} média_embaralhada=${meanShuffled.toFixed(4)} min_embaralhado=${Math.min(...shuffleLosses).toFixed(4)}`);
    console.log(`permutações <= real: ${beatOrTied}/${PERMUTATIONS} (p empírico ≈ ${pValue.toFixed(4)})`);
  }
}

console.timeEnd("total");
