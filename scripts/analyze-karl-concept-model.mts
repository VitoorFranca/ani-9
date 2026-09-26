// NOTE: this pipeline was built for the KARL dataset test, but the test was
// CLOSED before running it to completion — see KARL_REPORT.md. The gap>=1-day
// regime (the only one representative of spaced review, the project's actual
// use case) has only 6 qualifying users / 223 reviews / 54 failures on this
// dataset, below the statistical power needed for a meaningful grid
// search + bootstrap + 1000x permutation. Kept as validated (2-user smoke
// tested) infrastructure in case a larger or differently-filtered KARL-like
// dataset becomes available later. Uses replayCardFractional, not
// replayCard, to avoid the degenerate FSRS baseline documented in
// KARL_PROTOCOL.md (forgetting_curve(0, S) = 1 for every same-day review).
import { loadKarlParquet, loadFactAnswers, buildKarlUserDatasets, type KarlUserDataset } from "../src/ingest/karl.ts";
import { FSRSAlgorithm, generatorParameters } from "ts-fsrs";
import { replayCardFractional, splitChronological, optimizeParameters } from "../src/fsrs/index.ts";
import type { ReplayedReview } from "../src/fsrs/replay.ts";
import { extractVocabularyConcepts } from "../src/concepts/vocabulary.ts";
import { computeNeighborSets, GraphBayesianModel, rescaleSimilarity, type Neighbor, type WeightedLink } from "../src/model/index.ts";
import { Embedder } from "../src/embeddings/embed.ts";
import { logLoss, auc, bootstrapLogLossDeltaByGroup, type ScoredReview } from "../src/eval/index.ts";

const DAY_MS = 86_400_000;
console.time("total");

// ---------------------------------------------------------------------------
// 1. Ingest + per-user filter (fixed definition, see KARL_PROTOCOL.md)
// ---------------------------------------------------------------------------

const records = await loadKarlParquet("./data/karl/train-00000-of-00001.parquet");
const answers = await loadFactAnswers("./data/karl/facts.csv");
const datasets = buildKarlUserDatasets(records, answers);
console.log(`registros: ${records.length}, usuários: ${datasets.size}`);

const defaultAlgoForFilter = new FSRSAlgorithm(generatorParameters());

interface QualifyingUser {
  userId: string;
  ds: KarlUserDataset;
}

const qualifying: QualifyingUser[] = [];
for (const [userId, ds] of datasets) {
  const replayed = replayCardFractional(defaultAlgoForFilter, ds.reviews);
  const evaluableReviews = replayed.filter((r) => r.predictedR !== null).length;
  const { test } = splitChronological(ds.reviews, 0.7);
  const testIds = new Set(test.map((r) => r.id));
  const testFailures = replayed.filter((r) => testIds.has(r.reviewId) && r.predictedR !== null && r.label === 0).length;
  if (evaluableReviews >= 200 && testFailures >= 20) qualifying.push({ userId, ds });
}
console.log(`usuários qualificados (>=200 avaliáveis, >=20 falhas no teste): ${qualifying.length} / ${datasets.size}`);

const SAMPLE_LIMIT = process.env["KARL_SAMPLE"] ? Number(process.env["KARL_SAMPLE"]) : null;
const usersToRun = SAMPLE_LIMIT ? qualifying.slice(0, SAMPLE_LIMIT) : qualifying;
console.log(`rodando pipeline em ${usersToRun.length} usuário(s)${SAMPLE_LIMIT ? " (amostra de teste)" : ""}`);

// ---------------------------------------------------------------------------
// 2. Grids (fixed in KARL_PROTOCOL.md, before any results)
// ---------------------------------------------------------------------------

const PRIOR_VARIANCE_GRID = [0.25, 1];
const DRIFT_PER_DAY_GRID = [0.001, 0.01];
const LAMBDA_GRID = [0, 0.25, 0.5, 1, 2];
const TAU_GRID = [0.5, 0.7, 0.85, 0.95];
const NEIGHBOR_K = 5;

interface ConceptHp { priorVariance: number; driftPerDay: number; lambda: number }
interface NeighborHp { priorVariance: number; driftPerDay: number; tau: number; lambda: number }

// ---------------------------------------------------------------------------
// 3. Per-user pipeline pieces
// ---------------------------------------------------------------------------

interface EvalPoint {
  cardId: number;
  p: number;
  y: 0 | 1;
  elapsedDays: number;
}

function runConceptModel(
  replayed: readonly ReplayedReview[],
  cutoffId: number,
  conceptsByCard: ReadonlyMap<number, string[]>,
  hp: ConceptHp,
  trainOnly: boolean,
): EvalPoint[] {
  const model = new GraphBayesianModel<string>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  const out: EvalPoint[] = [];
  for (const r of replayed) {
    if (r.predictedR === null) continue;
    const day = Math.floor(r.reviewId / DAY_MS);
    const links: WeightedLink<string>[] = (conceptsByCard.get(r.cardId) ?? []).map((name) => ({ id: name, weight: hp.lambda }));
    const p = links.length > 0 ? model.predictAndUpdate(links, r.predictedR, r.label, day) : r.predictedR;
    const isTrainPeriod = r.reviewId < cutoffId;
    if (trainOnly ? isTrainPeriod : !isTrainPeriod) {
      out.push({ cardId: r.cardId, p, y: r.label, elapsedDays: r.elapsedDays! });
    }
  }
  return out;
}

function runNeighborModel(
  replayed: readonly ReplayedReview[],
  cutoffId: number,
  neighborsByCard: ReadonlyMap<number, Neighbor[]>,
  hp: NeighborHp,
  trainOnly: boolean,
): EvalPoint[] {
  const model = new GraphBayesianModel<number>({ priorVariance: hp.priorVariance, driftPerDay: hp.driftPerDay });
  const out: EvalPoint[] = [];
  for (const r of replayed) {
    if (r.predictedR === null) continue;
    const day = Math.floor(r.reviewId / DAY_MS);
    const neighbors = neighborsByCard.get(r.cardId) ?? [];
    const links: WeightedLink<number>[] = [
      { id: r.cardId, weight: 1 },
      ...neighbors.map((n) => ({ id: n.cardId, weight: rescaleSimilarity(n.weight, hp.tau, hp.lambda) })),
    ];
    const p = model.predictAndUpdate(links, r.predictedR, r.label, day);
    const isTrainPeriod = r.reviewId < cutoffId;
    if (trainOnly ? isTrainPeriod : !isTrainPeriod) {
      out.push({ cardId: r.cardId, p, y: r.label, elapsedDays: r.elapsedDays! });
    }
  }
  return out;
}

function conceptGridSearch(replayed: readonly ReplayedReview[], cutoffId: number, conceptsByCard: ReadonlyMap<number, string[]>): { best: ConceptHp; trainLogLoss: number } {
  let best: ConceptHp | null = null;
  let bestLoss = Infinity;
  for (const priorVariance of PRIOR_VARIANCE_GRID) {
    for (const driftPerDay of DRIFT_PER_DAY_GRID) {
      for (const lambda of LAMBDA_GRID) {
        const hp = { priorVariance, driftPerDay, lambda };
        const loss = logLoss(runConceptModel(replayed, cutoffId, conceptsByCard, hp, true));
        if (loss < bestLoss) { bestLoss = loss; best = hp; }
      }
    }
  }
  return { best: best!, trainLogLoss: bestLoss };
}

function neighborGridSearch(replayed: readonly ReplayedReview[], cutoffId: number, neighborsByCard: ReadonlyMap<number, Neighbor[]>): { best: NeighborHp; trainLogLoss: number } {
  let best: NeighborHp | null = null;
  let bestLoss = Infinity;
  for (const priorVariance of PRIOR_VARIANCE_GRID) {
    for (const driftPerDay of DRIFT_PER_DAY_GRID) {
      for (const tau of TAU_GRID) {
        for (const lambda of LAMBDA_GRID) {
          const hp = { priorVariance, driftPerDay, tau, lambda };
          const loss = logLoss(runNeighborModel(replayed, cutoffId, neighborsByCard, hp, true));
          if (loss < bestLoss) { bestLoss = loss; best = hp; }
        }
      }
    }
  }
  return { best: best!, trainLogLoss: bestLoss };
}

interface UserRunResult {
  userId: string;
  fsrsTest: EvalPoint[];
  mainTest: EvalPoint[];
  deckTest: EvalPoint[];
  globalTest: EvalPoint[];
  embeddingTest: EvalPoint[];
  mainConceptsByCard: Map<number, string[]>;
  deckConceptsByCard: Map<number, string[]>;
  cutoffId: number;
  replayed: ReplayedReview[];
}

const embedder = new Embedder();

async function runUser(userId: string, ds: KarlUserDataset): Promise<UserRunResult> {
  const { train, test } = splitChronological(ds.reviews, 0.7);
  const cutoffId = test[0]?.id ?? Infinity;

  const opt = await optimizeParameters(train);
  const algo = new FSRSAlgorithm(generatorParameters({ w: opt.optimizedParameters ?? opt.defaultParameters }));
  const replayed = replayCardFractional(algo, ds.reviews);

  const fsrsTest: EvalPoint[] = replayed
    .filter((r) => r.predictedR !== null && r.reviewId >= cutoffId)
    .map((r) => ({ cardId: r.cardId, p: r.predictedR!, y: r.label, elapsedDays: r.elapsedDays! }));

  const mainConceptsByCard = new Map<number, string[]>();
  const deckConceptsByCard = new Map<number, string[]>();
  const globalConceptsByCard = new Map<number, string[]>();
  for (const [cardId, card] of ds.cards) {
    mainConceptsByCard.set(cardId, extractVocabularyConcepts(card.front, { excludeFunctionWords: true }).map((v) => v.name));
    const deck = ds.deckByCard.get(cardId);
    deckConceptsByCard.set(cardId, [`deck:${deck?.deckId ?? "?"}`]);
    globalConceptsByCard.set(cardId, ["__GLOBAL__"]);
  }

  const mainGrid = conceptGridSearch(replayed, cutoffId, mainConceptsByCard);
  const mainTest = runConceptModel(replayed, cutoffId, mainConceptsByCard, mainGrid.best, false);

  const deckGrid = conceptGridSearch(replayed, cutoffId, deckConceptsByCard);
  const deckTest = runConceptModel(replayed, cutoffId, deckConceptsByCard, deckGrid.best, false);

  const globalGrid = conceptGridSearch(replayed, cutoffId, globalConceptsByCard);
  const globalTest = runConceptModel(replayed, cutoffId, globalConceptsByCard, globalGrid.best, false);

  const cardsForEmbedding = [...ds.cards.values()].map((c) => ({ cardId: c.cardId, front: c.front }));
  const neighborSets = await computeNeighborSets(cardsForEmbedding, embedder, NEIGHBOR_K);
  const embeddingNeighbors = neighborSets.embedding;
  const embeddingGrid = neighborGridSearch(replayed, cutoffId, embeddingNeighbors);
  const embeddingTest = runNeighborModel(replayed, cutoffId, embeddingNeighbors, embeddingGrid.best, false);

  return { userId, fsrsTest, mainTest, deckTest, globalTest, embeddingTest, mainConceptsByCard, deckConceptsByCard, cutoffId, replayed };
}

const results: UserRunResult[] = [];
let i = 0;
for (const { userId, ds } of usersToRun) {
  i++;
  const t0 = Date.now();
  const result = await runUser(userId, ds);
  console.log(`[${i}/${usersToRun.length}] user=${userId} reviews=${ds.reviews.length} cards=${ds.cards.size} testN=${result.fsrsTest.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  results.push(result);
}

// ---------------------------------------------------------------------------
// 4. Aggregate across users (bootstrap CI grouped by user)
// ---------------------------------------------------------------------------

function pool(
  results: readonly UserRunResult[],
  pick: (r: UserRunResult) => EvalPoint[],
  cut: "total" | "sameDay" | "gapDay",
): { scored: ScoredReview[]; groupIds: string[] } {
  const scored: ScoredReview[] = [];
  const groupIds: string[] = [];
  for (const r of results) {
    const points = pick(r);
    for (const pt of points) {
      if (cut === "sameDay" && pt.elapsedDays !== 0) continue;
      if (cut === "gapDay" && pt.elapsedDays < 1) continue;
      scored.push({ cardId: pt.cardId, p: pt.p, y: pt.y });
      groupIds.push(r.userId);
    }
  }
  return { scored, groupIds };
}

function report(label: string, variantPick: (r: UserRunResult) => EvalPoint[]) {
  console.log(`\n${"=".repeat(70)}\n${label}\n${"=".repeat(70)}`);
  for (const cut of ["total", "sameDay", "gapDay"] as const) {
    const fsrs = pool(results, (r) => r.fsrsTest, cut);
    const variant = pool(results, variantPick, cut);
    const fsrsLoss = logLoss(fsrs.scored);
    const variantLoss = logLoss(variant.scored);
    const boot = bootstrapLogLossDeltaByGroup(fsrs.scored, variant.scored, fsrs.groupIds, { iterations: 2000, seed: 42 });
    console.log(
      `[${cut}] n=${fsrs.scored.length} FSRS logLoss=${fsrsLoss.toFixed(4)} AUC=${auc(fsrs.scored).toFixed(4)} | ` +
      `variante logLoss=${variantLoss.toFixed(4)} AUC=${auc(variant.scored).toFixed(4)} | ` +
      `Δ=${boot.meanDelta.toFixed(4)} CI95=[${boot.ci95[0].toFixed(4)}, ${boot.ci95[1].toFixed(4)}]`,
    );
  }
}

report("Variante principal: vocabulário sem palavras funcionais", (r) => r.mainTest);
report("Controle: nó por deck", (r) => r.deckTest);
report("Controle: nó global único", (r) => r.globalTest);
report("Comparação: vizinhos por embedding local", (r) => r.embeddingTest);

// Direct main-vs-embedding comparison (part of the success criterion).
{
  console.log(`\n${"=".repeat(70)}\nComparação direta: principal vs. vizinhos por embedding\n${"=".repeat(70)}`);
  const main = pool(results, (r) => r.mainTest, "total");
  const embedding = pool(results, (r) => r.embeddingTest, "total");
  const boot = bootstrapLogLossDeltaByGroup(embedding.scored, main.scored, embedding.groupIds, { iterations: 2000, seed: 42 });
  console.log(
    `logLoss principal=${logLoss(main.scored).toFixed(4)} logLoss embedding=${logLoss(embedding.scored).toFixed(4)} ` +
    `Δ(embedding-principal)=${boot.meanDelta.toFixed(4)} CI95=[${boot.ci95[0].toFixed(4)}, ${boot.ci95[1].toFixed(4)}]`,
  );
}

console.timeEnd("total");
