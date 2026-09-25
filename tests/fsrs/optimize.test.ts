import { describe, expect, it } from "vitest";
import { buildTrainingItems, optimizeParameters, splitChronological } from "../../src/fsrs/optimize.js";
import type { Review } from "../../src/ingest/types.js";

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 0, 1);

function review(id: number, cardId: number, rating: 1 | 2 | 3 | 4, type = 0): Review {
  return { id, cardId, rating, type };
}

describe("splitChronological", () => {
  it("splits at the 70th percentile position by global time order", () => {
    const reviews = Array.from({ length: 10 }, (_, i) => review(BASE + i * DAY, 1, 3));
    const { train, test } = splitChronological(reviews);
    expect(train).toHaveLength(7);
    expect(test).toHaveLength(3);
    expect(train.at(-1)?.id).toBeLessThan(test[0]!.id);
  });

  it("keeps a stable chronological order regardless of input order", () => {
    const shuffled = [review(BASE + 2 * DAY, 1, 3), review(BASE, 1, 3), review(BASE + DAY, 1, 3)];
    const { train } = splitChronological(shuffled, 1);
    expect(train.map((r) => r.id)).toEqual([BASE, BASE + DAY, BASE + 2 * DAY]);
  });
});

describe("buildTrainingItems", () => {
  it("builds one cumulative item per review once the prefix has a long-term (delta_t>0) review", () => {
    const reviews = [review(BASE, 1, 3, 0), review(BASE + DAY, 1, 3, 1), review(BASE + 3 * DAY, 1, 3, 1)];
    const items = buildTrainingItems(reviews);
    // The lone-first-review prefix (all delta_t=0) is never emitted as its
    // own item — fsrs-rs rejects it (see buildTrainingItems' doc comment).
    expect(items).toHaveLength(2);
    expect(items[0]!.reviews).toHaveLength(2);
    expect(items[1]!.reviews).toHaveLength(3);
    expect(items[1]!.reviews[2]!.deltaT).toBe(2);
    expect(items[0]!.reviews[0]!.deltaT).toBe(0);
    expect(items[0]!.reviews[1]!.deltaT).toBe(1);
  });

  it("skips a card whose kept history doesn't start with a learning-step review", () => {
    const reviews = [review(BASE, 1, 3, 1), review(BASE + DAY, 1, 3, 1)];
    expect(buildTrainingItems(reviews)).toHaveLength(0);
  });

  it("never emits an item where every review has delta_t=0 (fsrs-rs rejects these)", () => {
    // A card with only one review ever: no long-term review exists, so no item.
    expect(buildTrainingItems([review(BASE, 1, 3, 0)])).toHaveLength(0);
  });

  it("handles multiple cards independently", () => {
    const reviews = [review(BASE, 1, 3, 0), review(BASE, 2, 3, 0), review(BASE + DAY, 2, 3, 1)];
    const items = buildTrainingItems(reviews);
    // card 1 never gets a long-term review (single review) -> 0 items;
    // card 2's second review makes the prefix long-term -> 1 item.
    expect(items).toHaveLength(1);
  });
});

describe("optimizeParameters", () => {
  it("returns default parameters and a fallback reason when there's no usable training data", async () => {
    const result = await optimizeParameters([]);
    expect(result.optimizedParameters).toBeNull();
    expect(result.fallbackReason).not.toBeNull();
    expect(result.defaultParameters.length).toBeGreaterThan(0);
  });

  it("runs the real native optimizer end-to-end on a small synthetic dataset", async () => {
    // Exercises the actual @open-spaced-repetition/binding native module,
    // not a mock, to catch platform/install issues (the plan's flagged risk).
    const reviews: Review[] = [];
    let cardId = 1;
    for (; cardId <= 20; cardId++) {
      let t = BASE;
      for (let i = 0; i < 6; i++) {
        reviews.push(review(t, cardId, i === 2 ? 1 : 3, i === 0 ? 0 : 1));
        t += (i + 1) * DAY;
      }
    }

    const result = await optimizeParameters(reviews);
    expect(result.fallbackReason).toBeNull();
    expect(result.optimizedParameters).not.toBeNull();
    expect(result.optimizedParameters!.length).toBe(result.defaultParameters.length);
  }, 30_000);
});
