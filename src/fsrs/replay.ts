import { FSRSAlgorithm } from "ts-fsrs";
import type { FSRSState } from "ts-fsrs";
import type { Review } from "../ingest/types.js";

const MS_PER_DAY = 86_400_000;

export interface ReplayedReview {
  reviewId: number;
  cardId: number;
  rating: 1 | 2 | 3 | 4;
  /** Days since the card's previous kept review; null for the card's first review. */
  elapsedDays: number | null;
  /** R computed from the prior state, before this review; null for the first review (no prior state). */
  predictedR: number | null;
  /** True when this review is eligible for evaluation metrics (elapsedDays >= 1). */
  includedInEval: boolean;
  /** Binary recall label: 0 for Again, 1 for Hard/Good/Easy. */
  label: 0 | 1;
  stateBefore: FSRSState | null;
  stateAfter: FSRSState;
}

/** Replays one card's reviews in chronological order through the FSRS algorithm. */
export function replayCard(algorithm: FSRSAlgorithm, reviews: readonly Review[]): ReplayedReview[] {
  const sorted = [...reviews].sort((a, b) => a.id - b.id);
  const result: ReplayedReview[] = [];

  let state: FSRSState | null = null;
  let lastTimestamp: number | null = null;

  for (const review of sorted) {
    const elapsedDays = lastTimestamp === null ? null : Math.floor((review.id - lastTimestamp) / MS_PER_DAY);
    const t = elapsedDays ?? 0;
    const predictedR = state === null ? null : algorithm.forgetting_curve(t, state.stability);
    const stateAfter = algorithm.next_state(state, t, review.rating);

    result.push({
      reviewId: review.id,
      cardId: review.cardId,
      rating: review.rating,
      elapsedDays,
      predictedR,
      includedInEval: elapsedDays !== null && elapsedDays >= 1,
      label: review.rating === 1 ? 0 : 1,
      stateBefore: state,
      stateAfter,
    });

    state = stateAfter;
    lastTimestamp = review.id;
  }

  return result;
}

/** Replays every card's review history independently, returned in global chronological order. */
export function replayAll(algorithm: FSRSAlgorithm, reviews: readonly Review[]): ReplayedReview[] {
  const byCard = new Map<number, Review[]>();
  for (const review of reviews) {
    const forCard = byCard.get(review.cardId);
    if (forCard) {
      forCard.push(review);
    } else {
      byCard.set(review.cardId, [review]);
    }
  }

  const all: ReplayedReview[] = [];
  for (const cardReviews of byCard.values()) {
    all.push(...replayCard(algorithm, cardReviews));
  }

  all.sort((a, b) => a.reviewId - b.reviewId);
  return all;
}

/**
 * Same as {@link replayCard}, but feeds `next_state`/`forgetting_curve` the
 * exact fractional elapsed time (`elapsedMs / MS_PER_DAY`) instead of
 * flooring it to a whole day. `elapsedDays` on the returned record is still
 * the floored integer (unchanged classification into same-day/gap>=1-day
 * cuts) — only the `t` fed into the FSRS math changes.
 *
 * `replayCard`'s flooring is correct for Anki data (reviews are almost
 * always >=1 day apart in practice), but degenerate on datasets with heavy
 * same-day repetition (confirmed on KARL: `forgetting_curve(0, S) = 1`
 * exactly, for every stability, so every same-day review gets predictedR=1
 * regardless of the true outcome — an uninformative FSRS baseline for ~91%
 * of KARL's evaluable reviews). This function exists so KARL's FSRS
 * baseline (and every concept-graph variant built on its `predictedR`) can
 * actually discriminate same-day reviews instead of always predicting
 * certain recall.
 *
 * Deliberately NOT used for `buildTrainingItems`/`optimizeParameters`: the
 * native fsrs-rs optimizer is validated against whole-day delta_t and an
 * unexpected fractional value could trigger its (uncatchable) native panic
 * — the same risk documented on the delta_t=0 case in optimize.ts. FSRS
 * parameters are still fit on floored, whole-day training data; only
 * replay (prediction time) uses the fractional value.
 */
export function replayCardFractional(algorithm: FSRSAlgorithm, reviews: readonly Review[]): ReplayedReview[] {
  const sorted = [...reviews].sort((a, b) => a.id - b.id);
  const result: ReplayedReview[] = [];

  let state: FSRSState | null = null;
  let lastTimestamp: number | null = null;

  for (const review of sorted) {
    const elapsedDaysFractional = lastTimestamp === null ? null : (review.id - lastTimestamp) / MS_PER_DAY;
    const t = elapsedDaysFractional ?? 0;
    const predictedR = state === null ? null : algorithm.forgetting_curve(t, state.stability);
    const stateAfter = algorithm.next_state(state, t, review.rating);

    result.push({
      reviewId: review.id,
      cardId: review.cardId,
      rating: review.rating,
      elapsedDays: elapsedDaysFractional === null ? null : Math.floor(elapsedDaysFractional),
      predictedR,
      includedInEval: elapsedDaysFractional !== null && elapsedDaysFractional >= 1,
      label: review.rating === 1 ? 0 : 1,
      stateBefore: state,
      stateAfter,
    });

    state = stateAfter;
    lastTimestamp = review.id;
  }

  return result;
}

/** Fractional-time counterpart to {@link replayAll} — see {@link replayCardFractional}. */
export function replayAllFractional(algorithm: FSRSAlgorithm, reviews: readonly Review[]): ReplayedReview[] {
  const byCard = new Map<number, Review[]>();
  for (const review of reviews) {
    const forCard = byCard.get(review.cardId);
    if (forCard) {
      forCard.push(review);
    } else {
      byCard.set(review.cardId, [review]);
    }
  }

  const all: ReplayedReview[] = [];
  for (const cardReviews of byCard.values()) {
    all.push(...replayCardFractional(algorithm, cardReviews));
  }

  all.sort((a, b) => a.reviewId - b.reviewId);
  return all;
}
