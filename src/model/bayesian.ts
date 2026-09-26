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

export interface WeightedLink<Id = number> {
  id: Id;
  weight: number;
}

/**
 * Builds links for the "base node + optional extra nodes" pattern shared by
 * every deck/topic/concept variant in the Misael analysis scripts: a fixed
 * base node (e.g. `deck:X`) at `lambdaBase`, plus zero or more extra nodes
 * (e.g. concept or topic names) each at `lambdaExtra / extra.length`
 * (average, not sum, across the extra group).
 *
 * Centralized here after the SAME bug — a card with no `baseId` (e.g.
 * contentless, excluded from the eligible set) getting a spurious
 * `"deck:undefined"` link instead of falling back to no links at all (pure
 * FSRS passthrough) — was independently reintroduced twice in separate
 * analysis scripts that each hand-rolled this logic. `baseId === undefined`
 * always returns `[]`, matching every other variant's fallback, regardless
 * of whether `extra` is non-empty.
 *
 * At `lambdaExtra = 0`, the result is provably equivalent to the base-only
 * case (extra links carry weight 0, which `GraphBayesianModel` treats as a
 * complete no-op for both prediction and update) — verified by test.
 */
export function buildCombinedLinks<Id>(
  baseId: Id | undefined,
  extra: readonly Id[],
  hp: { lambdaBase: number; lambdaExtra: number },
): WeightedLink<Id>[] {
  if (baseId === undefined) return [];
  const links: WeightedLink<Id>[] = [{ id: baseId, weight: hp.lambdaBase }];
  for (const id of extra) links.push({ id, weight: hp.lambdaExtra / extra.length });
  return links;
}

interface NodeState {
  theta: number;
  variance: number;
  lastUpdateDay: number;
}

/**
 * Online Gaussian-approximation logistic model over an arbitrary weighted
 * graph of nodes. Generic over the node id type: the neighbor-similarity
 * model links a card to itself (weight 1) plus its top-k neighbor cards
 * (`Id = number`); the concept-membership model links a card directly to
 * the names of the concepts it has (`Id = string`), with no self-link —
 * exactly the spec's original per-concept Bayesian update (prior variance,
 * per-day drift, closed-form online logistic step), just phrased generically
 * so both linking schemes reuse the same math. With every node's theta at
 * 0, predictAndUpdate returns exactly `fsrsR` (see the equivalence test) —
 * the model is a pure FSRS pass-through until evidence accumulates.
 */
export class GraphBayesianModel<Id = number> {
  private readonly nodes = new Map<Id, NodeState>();

  constructor(private readonly hp: BayesianHyperparams) {}

  getState(id: Id): { theta: number; variance: number } | undefined {
    const node = this.nodes.get(id);
    return node ? { theta: node.theta, variance: node.variance } : undefined;
  }

  private getOrInitNode(id: Id, day: number): NodeState {
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
    links: readonly WeightedLink<Id>[],
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
