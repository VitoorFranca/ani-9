export interface ScoredReview {
  cardId: number;
  /** Predicted probability of recall. */
  p: number;
  /** Observed outcome: 0 = Again, 1 = Hard/Good/Easy. */
  y: 0 | 1;
}

const CLAMP_EPS = 1e-4;

function clampProbability(p: number): number {
  return Math.min(1 - CLAMP_EPS, Math.max(CLAMP_EPS, p));
}

export function logLoss(predictions: readonly ScoredReview[]): number {
  if (predictions.length === 0) return NaN;
  let sum = 0;
  for (const { p, y } of predictions) {
    const clamped = clampProbability(p);
    sum += y === 1 ? -Math.log(clamped) : -Math.log(1 - clamped);
  }
  return sum / predictions.length;
}

export function accuracy(predictions: readonly ScoredReview[], threshold = 0.5): number {
  if (predictions.length === 0) return NaN;
  const correct = predictions.filter(({ p, y }) => (p >= threshold ? 1 : 0) === y).length;
  return correct / predictions.length;
}

/** ROC AUC via the rank-sum (Mann-Whitney U) method, with average ranks for ties. */
export function auc(predictions: readonly ScoredReview[]): number {
  const positiveCount = predictions.filter((r) => r.y === 1).length;
  const negativeCount = predictions.length - positiveCount;
  if (positiveCount === 0 || negativeCount === 0) return NaN;

  const sorted = [...predictions].sort((a, b) => a.p - b.p);
  const ranks = new Array<number>(sorted.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]!.p === sorted[i]!.p) j++;
    const averageRank = (i + j) / 2 + 1; // 1-indexed
    for (let k = i; k <= j; k++) ranks[k] = averageRank;
    i = j + 1;
  }

  let positiveRankSum = 0;
  sorted.forEach((r, idx) => {
    if (r.y === 1) positiveRankSum += ranks[idx]!;
  });

  const u = positiveRankSum - (positiveCount * (positiveCount + 1)) / 2;
  return u / (positiveCount * negativeCount);
}

export interface CalibrationBin {
  binStart: number;
  binEnd: number;
  count: number;
  meanPredicted: number;
  observedRate: number;
}

export function calibrationBins(predictions: readonly ScoredReview[], numBins = 10): CalibrationBin[] {
  const accumulators = Array.from({ length: numBins }, () => ({ sumP: 0, sumY: 0, count: 0 }));

  for (const { p, y } of predictions) {
    const idx = Math.min(numBins - 1, Math.max(0, Math.floor(p * numBins)));
    const bin = accumulators[idx]!;
    bin.sumP += p;
    bin.sumY += y;
    bin.count += 1;
  }

  return accumulators.map((bin, i) => ({
    binStart: i / numBins,
    binEnd: (i + 1) / numBins,
    count: bin.count,
    meanPredicted: bin.count > 0 ? bin.sumP / bin.count : 0,
    observedRate: bin.count > 0 ? bin.sumY / bin.count : 0,
  }));
}

/** Count-weighted RMSE between mean predicted R and observed recall rate across bins. */
export function calibrationRmse(predictions: readonly ScoredReview[], numBins = 10): number {
  const bins = calibrationBins(predictions, numBins).filter((b) => b.count > 0);
  const totalCount = bins.reduce((sum, b) => sum + b.count, 0);
  if (totalCount === 0) return NaN;

  const weightedSquaredError = bins.reduce(
    (sum, b) => sum + b.count * (b.meanPredicted - b.observedRate) ** 2,
    0,
  );
  return Math.sqrt(weightedSquaredError / totalCount);
}

/** Deterministic PRNG (mulberry32) so bootstrap results are reproducible across runs. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapResult {
  meanDelta: number;
  ci95: [number, number];
  iterations: number;
}

/**
 * Bootstraps the log-loss delta between two prediction sets over the SAME
 * reviews (aligned by index; only `p` should differ), resampling by CARD
 * (not by review), since reviews of the same card are correlated and
 * resampling individual reviews would understate the true uncertainty.
 *
 * delta = logLoss(reference) - logLoss(comparison); positive means the
 * comparison model has lower (better) log-loss than the reference.
 */
export function bootstrapLogLossDelta(
  referencePredictions: readonly ScoredReview[],
  comparisonPredictions: readonly ScoredReview[],
  opts: { iterations?: number; seed?: number } = {},
): BootstrapResult {
  if (referencePredictions.length !== comparisonPredictions.length) {
    throw new Error("referencePredictions and comparisonPredictions must be aligned (same length)");
  }

  const iterations = opts.iterations ?? 2000;
  const random = mulberry32(opts.seed ?? 42);

  const indicesByCard = new Map<number, number[]>();
  referencePredictions.forEach((r, idx) => {
    const forCard = indicesByCard.get(r.cardId);
    if (forCard) forCard.push(idx);
    else indicesByCard.set(r.cardId, [idx]);
  });
  const cardIds = [...indicesByCard.keys()];

  if (cardIds.length === 0) {
    return { meanDelta: 0, ci95: [0, 0], iterations: 0 };
  }

  const deltas: number[] = [];
  for (let iter = 0; iter < iterations; iter++) {
    const sampleReference: ScoredReview[] = [];
    const sampleComparison: ScoredReview[] = [];

    for (let k = 0; k < cardIds.length; k++) {
      const pickedCard = cardIds[Math.floor(random() * cardIds.length)]!;
      for (const idx of indicesByCard.get(pickedCard)!) {
        sampleReference.push(referencePredictions[idx]!);
        sampleComparison.push(comparisonPredictions[idx]!);
      }
    }

    deltas.push(logLoss(sampleReference) - logLoss(sampleComparison));
  }

  deltas.sort((a, b) => a - b);
  const lo = deltas[Math.floor(0.025 * deltas.length)]!;
  const hi = deltas[Math.min(deltas.length - 1, Math.floor(0.975 * deltas.length))]!;
  const meanDelta = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;

  return { meanDelta, ci95: [lo, hi], iterations };
}

/** A prediction set that always predicts the constant train hit-rate. */
export function constantBaselinePredictions(
  trainLabels: readonly (0 | 1)[],
  testReviews: readonly { cardId: number; y: 0 | 1 }[],
): ScoredReview[] {
  let labelSum = 0;
  for (const label of trainLabels) labelSum += label;
  const p = trainLabels.length > 0 ? labelSum / trainLabels.length : 0.5;
  return testReviews.map((r) => ({ cardId: r.cardId, p, y: r.y }));
}
