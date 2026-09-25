const CLAMP_EPS = 1e-4;
const MIN_VARIANCE = 1e-6;

function clampProbability(p: number): number {
  return Math.min(1 - CLAMP_EPS, Math.max(CLAMP_EPS, p));
}

function logit(p: number): number {
  const c = clampProbability(p);
  return Math.log(c / (1 - c));
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export interface BayesianHyperparams {
  priorVariance: number;
  driftPerDay: number;
}

/**
 * Rescales a raw absolute-scale similarity (see neighbors.ts's
 * `Neighbor.weight`) into a link weight, with two knobs meant to be
 * grid-searched on train data alongside the hyperparameters above:
 *  - `tau` (floor): similarity at or below `tau` contributes nothing;
 *    above it, weight rises linearly from 0 (at tau) to 1 (at similarity=1).
 *  - `lambda` (global strength): multiplies the whole result. `lambda=0`
 *    zeroes every link weight — including the reviewed card's own
 *    self-link — which makes GraphBayesianModel a pure FSRS pass-through
 *    (theta can never move away from 0), so a grid search that includes
 *    lambda=0 can never do worse than the FSRS baseline on the metric it
 *    optimizes.
 */
export function rescaleSimilarity(similarity: number, tau: number, lambda: number): number {
  if (tau >= 1) return 0;
  return lambda * Math.max(0, (similarity - tau) / (1 - tau));
}

export interface WeightedLink {
  id: number;
  weight: number;
}

interface NodeState {
  theta: number;
  variance: number;
  lastUpdateDay: number;
}

/**
 * Online Gaussian-approximation logistic model over an arbitrary weighted
 * graph of nodes (here: cards linked to their own top-k similarity
 * neighbors, each card also linked to itself with weight 1). This is the
 * spec's original per-concept Bayesian update (prior variance, per-day
 * drift, closed-form online logistic step) with "concept" generalized to
 * "linked node" — a card's own id plays the role a concept name used to
 * play, and neighbor similarity plays the role concept weight (q_ic) used
 * to play. With every node's theta at 0, predictAndUpdate returns exactly
 * `fsrsR` (see the equivalence test) — the model is a pure FSRS pass-through
 * until evidence accumulates.
 */
export class GraphBayesianModel {
  private readonly nodes = new Map<number, NodeState>();

  constructor(private readonly hp: BayesianHyperparams) {}

  getState(id: number): { theta: number; variance: number } | undefined {
    const node = this.nodes.get(id);
    return node ? { theta: node.theta, variance: node.variance } : undefined;
  }

  private getOrInitNode(id: number, day: number): NodeState {
    let node = this.nodes.get(id);
    if (!node) {
      node = { theta: 0, variance: this.hp.priorVariance, lastUpdateDay: day };
      this.nodes.set(id, node);
    }
    return node;
  }

  private applyDrift(node: NodeState, day: number): void {
    const elapsedDays = Math.max(0, day - node.lastUpdateDay);
    node.variance += this.hp.driftPerDay * elapsedDays;
    node.lastUpdateDay = day;
  }

  /**
   * Predicts recall probability for a review, combining FSRS's `fsrsR` with
   * the accumulated theta of every node in `links` (typically the reviewed
   * card itself at weight 1, plus its neighbors weighted by similarity),
   * then updates every linked node's (theta, variance) from the observed
   * outcome `y`. Returns the prediction made BEFORE the update — that's
   * what must be scored for eval, matching the spec's "registrar ANTES de
   * atualizar."
   */
  predictAndUpdate(
    links: readonly WeightedLink[],
    fsrsR: number,
    y: 0 | 1,
    day: number,
    evidenceWeight = 1,
  ): number {
    const entries = links.map((link) => ({ link, node: this.getOrInitNode(link.id, day) }));
    for (const { node } of entries) this.applyDrift(node, day);

    const z = logit(fsrsR) + entries.reduce((sum, { link, node }) => sum + link.weight * node.theta, 0);
    const p = sigmoid(z);

    const s = entries.reduce((sum, { link, node }) => sum + link.weight ** 2 * node.variance, 0);
    const denom = 1 + p * (1 - p) * s;

    for (const { link, node } of entries) {
      const thetaStep = (evidenceWeight * node.variance * link.weight * (y - p)) / denom;
      node.theta += thetaStep;

      const varianceStep = (evidenceWeight * (node.variance * link.weight) ** 2 * p * (1 - p)) / denom;
      node.variance = Math.max(MIN_VARIANCE, node.variance - varianceStep);
    }

    return p;
  }
}

export interface GridSearchTrial {
  hyperparams: BayesianHyperparams;
  logLoss: number;
}

export interface GridSearchResult {
  best: BayesianHyperparams;
  logLoss: number;
  tried: GridSearchTrial[];
}

/**
 * Simple grid search over (priorVariance, driftPerDay), minimizing whatever
 * log-loss `runOnce` reports for a given hyperparameter setting. Decoupled
 * from FSRS/eval specifics: the caller's `runOnce` is responsible for
 * building a fresh GraphBayesianModel and replaying TRAIN-only data only —
 * this function just tries every combination and picks the best.
 */
export function gridSearchHyperparams(
  priorVarianceGrid: readonly number[],
  driftPerDayGrid: readonly number[],
  runOnce: (hyperparams: BayesianHyperparams) => number,
): GridSearchResult {
  const tried: GridSearchTrial[] = [];
  for (const priorVariance of priorVarianceGrid) {
    for (const driftPerDay of driftPerDayGrid) {
      const hyperparams = { priorVariance, driftPerDay };
      tried.push({ hyperparams, logLoss: runOnce(hyperparams) });
    }
  }
  const best = tried.reduce((a, b) => (b.logLoss < a.logLoss ? b : a));
  return { best: best.hyperparams, logLoss: best.logLoss, tried };
}
