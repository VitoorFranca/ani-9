import { describe, expect, it } from "vitest";
import { FSRSAlgorithm, generatorParameters } from "ts-fsrs";
import { replayAll, replayCard } from "../../src/fsrs/replay.js";
import type { Review } from "../../src/ingest/types.js";

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 0, 1);

function review(id: number, cardId: number, rating: 1 | 2 | 3 | 4, type = 0): Review {
  return { id, cardId, rating, type };
}

function algorithm(): FSRSAlgorithm {
  return new FSRSAlgorithm(generatorParameters());
}

describe("replayCard", () => {
  it("treats the first review as t=0 with no predicted R", () => {
    const [first] = replayCard(algorithm(), [review(BASE, 1, 3)]);
    expect(first?.elapsedDays).toBeNull();
    expect(first?.predictedR).toBeNull();
    expect(first?.includedInEval).toBe(false);
    expect(first?.stateAfter.stability).toBeGreaterThan(0);
  });

  it("computes elapsed days between consecutive reviews of the same card", () => {
    const reviews = [review(BASE, 1, 3), review(BASE + 5 * DAY, 1, 3)];
    const [, second] = replayCard(algorithm(), reviews);
    expect(second?.elapsedDays).toBe(5);
    expect(second?.includedInEval).toBe(true);
    expect(second?.predictedR).not.toBeNull();
    expect(second!.predictedR!).toBeGreaterThan(0);
    expect(second!.predictedR!).toBeLessThanOrEqual(1);
  });

  it("excludes same-day reviews from eval but still runs them through next_state", () => {
    const reviews = [review(BASE, 1, 3), review(BASE + 3 * 60 * 60 * 1000, 1, 3)]; // 3h later, same day
    const [, second] = replayCard(algorithm(), reviews);
    expect(second?.elapsedDays).toBe(0);
    expect(second?.includedInEval).toBe(false);
    // same-day reviews may legitimately leave stability unchanged (FSRS
    // short-term handling); what matters is the state is still defined and valid.
    expect(second?.stateAfter.stability).toBeGreaterThan(0);
    expect(second?.stateBefore).not.toBeNull();
  });

  it("maps rating to a binary recall label (Again=0, everything else=1)", () => {
    const reviews = [review(BASE, 1, 1), review(BASE + DAY, 1, 2), review(BASE + 2 * DAY, 1, 3), review(BASE + 3 * DAY, 1, 4)];
    const labels = replayCard(algorithm(), reviews).map((r) => r.label);
    expect(labels).toEqual([0, 1, 1, 1]);
  });

  it("a Good rating yields higher next stability than an Again rating from the same prior state", () => {
    const algo = algorithm();
    const afterAgain = replayCard(algo, [review(BASE, 1, 1), review(BASE + 5 * DAY, 1, 1)]);
    const afterGood = replayCard(algo, [review(BASE, 1, 1), review(BASE + 5 * DAY, 1, 3)]);
    expect(afterGood[1]!.stateAfter.stability).toBeGreaterThan(afterAgain[1]!.stateAfter.stability);
  });
});

describe("replayAll", () => {
  it("replays multiple cards independently and returns global chronological order", () => {
    const reviews = [
      review(BASE + 2 * DAY, 200, 3),
      review(BASE, 100, 3),
      review(BASE + DAY, 100, 3),
    ];
    const result = replayAll(algorithm(), reviews);
    expect(result.map((r) => r.reviewId)).toEqual([BASE, BASE + DAY, BASE + 2 * DAY]);
    // card 100's second review has a prior state; card 200's only review doesn't.
    expect(result.find((r) => r.reviewId === BASE + DAY)?.predictedR).not.toBeNull();
    expect(result.find((r) => r.reviewId === BASE + 2 * DAY)?.predictedR).toBeNull();
  });
});
