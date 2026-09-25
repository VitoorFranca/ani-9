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
