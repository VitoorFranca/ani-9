import { describe, expect, it } from "vitest";
import {
  accuracy,
  auc,
  bootstrapLogLossDelta,
  bootstrapLogLossDeltaByGroup,
  calibrationRmse,
  constantBaselinePredictions,
  logLoss,
  type ScoredReview,
} from "../../src/eval/metrics.js";

describe("logLoss", () => {
  it("is near zero for confident, correct predictions", () => {
    const preds: ScoredReview[] = [
      { cardId: 1, p: 0.99, y: 1 },
      { cardId: 2, p: 0.01, y: 0 },
    ];
    expect(logLoss(preds)).toBeLessThan(0.02);
  });

  it("is large for confident, wrong predictions", () => {
    const preds: ScoredReview[] = [
      { cardId: 1, p: 0.99, y: 0 },
      { cardId: 2, p: 0.01, y: 1 },
    ];
    expect(logLoss(preds)).toBeGreaterThan(4);
  });

  it("clamps probabilities so it never returns Infinity", () => {
    const preds: ScoredReview[] = [{ cardId: 1, p: 1, y: 0 }];
    expect(Number.isFinite(logLoss(preds))).toBe(true);
  });
});

describe("accuracy", () => {
  it("counts predictions on the correct side of the threshold", () => {
    const preds: ScoredReview[] = [
      { cardId: 1, p: 0.9, y: 1 },
      { cardId: 2, p: 0.4, y: 1 },
      { cardId: 3, p: 0.1, y: 0 },
    ];
    expect(accuracy(preds)).toBeCloseTo(2 / 3);
  });
});

describe("auc", () => {
  it("is 1 for perfect separation", () => {
    const preds: ScoredReview[] = [
      { cardId: 1, p: 0.9, y: 1 },
      { cardId: 2, p: 0.8, y: 1 },
      { cardId: 3, p: 0.2, y: 0 },
      { cardId: 4, p: 0.1, y: 0 },
    ];
    expect(auc(preds)).toBe(1);
  });

  it("is 0 for perfectly reversed predictions", () => {
    const preds: ScoredReview[] = [
      { cardId: 1, p: 0.1, y: 1 },
      { cardId: 2, p: 0.9, y: 0 },
    ];
    expect(auc(preds)).toBe(0);
  });

  it("is 0.5 for ties or no discrimination", () => {
    const preds: ScoredReview[] = [
      { cardId: 1, p: 0.5, y: 1 },
      { cardId: 2, p: 0.5, y: 0 },
    ];
    expect(auc(preds)).toBeCloseTo(0.5);
  });

  it("returns NaN when only one class is present", () => {
    const preds: ScoredReview[] = [
      { cardId: 1, p: 0.9, y: 1 },
      { cardId: 2, p: 0.1, y: 1 },
    ];
    expect(Number.isNaN(auc(preds))).toBe(true);
  });
});

describe("calibrationRmse", () => {
  it("is zero for a perfectly calibrated set of predictions", () => {
    // 10 predictions at p=0.5, exactly 5 of which recall -> observed rate 0.5.
    const preds: ScoredReview[] = Array.from({ length: 10 }, (_, i) => ({
      cardId: i,
      p: 0.5,
      y: (i < 5 ? 1 : 0) as 0 | 1,
    }));
    expect(calibrationRmse(preds, 10)).toBeCloseTo(0);
  });

  it("is positive when predictions are systematically overconfident", () => {
    const preds: ScoredReview[] = Array.from({ length: 10 }, (_, i) => ({
      cardId: i,
      p: 0.95,
      y: (i < 5 ? 1 : 0) as 0 | 1, // predicts 0.95 but observed rate is only 0.5
    }));
    expect(calibrationRmse(preds, 10)).toBeGreaterThan(0.3);
  });
});

describe("constantBaselinePredictions", () => {
  it("predicts the train label mean for every test review", () => {
    const preds = constantBaselinePredictions(
      [1, 1, 1, 0],
      [
        { cardId: 1, y: 1 },
        { cardId: 2, y: 0 },
      ],
    );
    expect(preds.every((p) => p.p === 0.75)).toBe(true);
    expect(preds.map((p) => p.y)).toEqual([1, 0]);
  });

  it("defaults to 0.5 when there are no train labels", () => {
    expect(constantBaselinePredictions([], [{ cardId: 1, y: 1 }])[0]?.p).toBe(0.5);
  });
});

describe("bootstrapLogLossDelta", () => {
  it("returns a zero-width interval at zero when both models are identical", () => {
    const preds: ScoredReview[] = [
      { cardId: 1, p: 0.7, y: 1 },
      { cardId: 2, p: 0.3, y: 0 },
    ];
    const result = bootstrapLogLossDelta(preds, preds, { iterations: 200, seed: 1 });
    expect(result.meanDelta).toBeCloseTo(0);
    expect(result.ci95[0]).toBeCloseTo(0);
    expect(result.ci95[1]).toBeCloseTo(0);
  });

  it("reports a positive delta when the comparison model is strictly better", () => {
    const reference: ScoredReview[] = Array.from({ length: 30 }, (_, i) => ({
      cardId: i,
      p: 0.5, // uninformative
      y: (i % 3 === 0 ? 0 : 1) as 0 | 1,
    }));
    const comparison: ScoredReview[] = reference.map((r) => ({ ...r, p: r.y === 1 ? 0.9 : 0.1 }));

    const result = bootstrapLogLossDelta(reference, comparison, { iterations: 500, seed: 7 });
    expect(result.meanDelta).toBeGreaterThan(0);
    expect(result.ci95[0]).toBeGreaterThan(0); // CI excludes zero
  });

  it("is deterministic for a fixed seed", () => {
    const reference: ScoredReview[] = Array.from({ length: 15 }, (_, i) => ({
      cardId: i,
      p: 0.6,
      y: (i % 2) as 0 | 1,
    }));
    const comparison: ScoredReview[] = reference.map((r) => ({ ...r, p: 0.4 }));

    const a = bootstrapLogLossDelta(reference, comparison, { iterations: 100, seed: 123 });
    const b = bootstrapLogLossDelta(reference, comparison, { iterations: 100, seed: 123 });
    expect(a).toEqual(b);
  });

  it("throws when the two prediction sets aren't aligned", () => {
    expect(() => bootstrapLogLossDelta([{ cardId: 1, p: 0.5, y: 1 }], [])).toThrow();
  });
});

describe("bootstrapLogLossDeltaByGroup", () => {
  it("agrees with bootstrapLogLossDelta when the group key is cardId", () => {
    const reference: ScoredReview[] = Array.from({ length: 15 }, (_, i) => ({
      cardId: i,
      p: 0.6,
      y: (i % 2) as 0 | 1,
    }));
    const comparison: ScoredReview[] = reference.map((r) => ({ ...r, p: 0.4 }));

    const byCard = bootstrapLogLossDelta(reference, comparison, { iterations: 200, seed: 5 });
    const byGroup = bootstrapLogLossDeltaByGroup(
      reference,
      comparison,
      reference.map((r) => r.cardId),
      { iterations: 200, seed: 5 },
    );
    expect(byGroup).toEqual(byCard);
  });

  it("resamples whole users together, not individual reviews", () => {
    // Two users, each contributing many reviews; the group (user) is the
    // unit of resampling so every bootstrap sample is a whole number of
    // users' reviews, never a fractional mix.
    const reference: ScoredReview[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ cardId: i, p: 0.5, y: (i % 2) as 0 | 1 })),
      ...Array.from({ length: 20 }, (_, i) => ({ cardId: 100 + i, p: 0.5, y: (i % 2) as 0 | 1 })),
    ];
    const comparison: ScoredReview[] = reference.map((r) => ({ ...r, p: r.y === 1 ? 0.9 : 0.1 }));
    const groupIds = [...Array(20).fill("userA"), ...Array(20).fill("userB")];

    const result = bootstrapLogLossDeltaByGroup(reference, comparison, groupIds, { iterations: 300, seed: 9 });
    expect(result.meanDelta).toBeGreaterThan(0);
    expect(result.ci95[0]).toBeGreaterThan(0);
  });

  it("throws when groupIds isn't aligned with the predictions", () => {
    expect(() =>
      bootstrapLogLossDeltaByGroup([{ cardId: 1, p: 0.5, y: 1 }], [{ cardId: 1, p: 0.5, y: 1 }], []),
    ).toThrow();
  });
});
