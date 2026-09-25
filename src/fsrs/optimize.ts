import { FSRSBindingItem, FSRSBindingReview, computeParameters } from "@open-spaced-repetition/binding";
import { generatorParameters } from "ts-fsrs";
import type { Review } from "../ingest/types.js";

const MS_PER_DAY = 86_400_000;

export interface TrainTestSplit {
  train: Review[];
  test: Review[];
}

/**
 * Splits the revlog chronologically by a global time cutoff (not per-card):
 * the cutoff sits at the 70th-percentile position of ALL reviews sorted by
 * time, and every review before it is train, every review at/after it is
 * test. A card's own reviews can straddle the cutoff; that's intentional —
 * replay.ts still walks each card's full history continuously, and this
 * split only decides which reviews may inform the optimizer (train) versus
 * which are scored (test).
 */
export function splitChronological(reviews: readonly Review[], trainFraction = 0.7): TrainTestSplit {
  const sorted = [...reviews].sort((a, b) => a.id - b.id);
  const splitIndex = Math.floor(sorted.length * trainFraction);
  return { train: sorted.slice(0, splitIndex), test: sorted.slice(splitIndex) };
}

/**
 * Builds one FSRSBindingItem per review, each containing the cumulative
 * review prefix (with per-step delta_t) up to and including that review —
 * the convention fsrs-rs itself uses to build training sets from a revlog
 * (confirmed via FSRSBindingItem's doc comment and its longTermReviewCnt/
 * includeLongTermReviews accessors, which exist specifically to let the
 * optimizer identify same-day vs long-term reviews within that prefix).
 *
 * Cards whose kept history doesn't start with a Learning-step review
 * (type 0) are skipped: their initial memory state is unknown, so they
 * can't be used to fit initial-stability/difficulty parameters.
 *
 * An item is only emitted once its cumulative prefix contains at least one
 * review with delta_t > 0. fsrs-rs's native validation panics (aborting the
 * whole process, not a catchable JS error) on an item where every review
 * has delta_t = 0 — e.g. a lone first review — so an all-same-day prefix
 * must never be pushed as its own item (confirmed by hitting exactly this
 * panic against real data during development).
 */
export function buildTrainingItems(trainReviews: readonly Review[]): FSRSBindingItem[] {
  const byCard = new Map<number, Review[]>();
  for (const review of trainReviews) {
    const forCard = byCard.get(review.cardId);
    if (forCard) {
      forCard.push(review);
    } else {
      byCard.set(review.cardId, [review]);
    }
  }

  const items: FSRSBindingItem[] = [];

  for (const reviews of byCard.values()) {
    const sorted = [...reviews].sort((a, b) => a.id - b.id);
    if (sorted[0]!.type !== 0) continue;

    const cumulative: FSRSBindingReview[] = [];
    let lastTimestamp: number | null = null;
    let hasLongTermReview = false;

    for (const review of sorted) {
      const deltaT = lastTimestamp === null ? 0 : Math.floor((review.id - lastTimestamp) / MS_PER_DAY);
      cumulative.push(new FSRSBindingReview(review.rating, deltaT));
      if (deltaT > 0) hasLongTermReview = true;
      if (hasLongTermReview) items.push(new FSRSBindingItem([...cumulative]));
      lastTimestamp = review.id;
    }
  }

  return items;
}

export interface OptimizationResult {
  defaultParameters: number[];
  optimizedParameters: number[] | null;
  /** Set when optimization couldn't run (e.g. too little training data, or the native binding is unavailable on this platform). */
  fallbackReason: string | null;
}

/**
 * Optimizes FSRS parameters from the training split, falling back to
 * default parameters (and recording why) if the native binding is
 * unavailable on this platform or optimization otherwise fails — this
 * shouldn't block the Phase 1 pipeline, just be reported honestly.
 */
export async function optimizeParameters(trainReviews: readonly Review[]): Promise<OptimizationResult> {
  const defaultParameters = [...generatorParameters().w];
  const items = buildTrainingItems(trainReviews);

  if (items.length === 0) {
    return {
      defaultParameters,
      optimizedParameters: null,
      fallbackReason: "No training items with a known initial state (Learning-step review) were found.",
    };
  }

  try {
    const optimizedParameters = await computeParameters(items, { enableShortTerm: true });
    return { defaultParameters, optimizedParameters, fallbackReason: null };
  } catch (error) {
    return {
      defaultParameters,
      optimizedParameters: null,
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}
