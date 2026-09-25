import { describe, expect, it } from "vitest";
import { computeIdfWeights } from "../../src/concepts/weights.js";
import type { CardConcepts } from "../../src/concepts/types.js";

describe("computeIdfWeights", () => {
  it("gives q=0 to a concept present in only a single card", () => {
    const cardConcepts: CardConcepts[] = [
      { cardId: 1, concepts: [{ name: "unique-thing", weight: 0.9 }] },
      { cardId: 2, concepts: [{ name: "common-thing", weight: 0.5 }] },
      { cardId: 3, concepts: [{ name: "common-thing", weight: 0.5 }] },
    ];
    const { weights } = computeIdfWeights(cardConcepts);
    const unique = weights.find((w) => w.concept === "unique-thing");
    expect(unique?.q).toBe(0);
  });

  it("gives the rarest concept the highest idf (normalized to 1)", () => {
    const cardConcepts: CardConcepts[] = [
      { cardId: 1, concepts: [{ name: "rare", weight: 1 }, { name: "common", weight: 1 }] },
      { cardId: 2, concepts: [{ name: "common", weight: 1 }] },
      { cardId: 3, concepts: [{ name: "common", weight: 1 }] },
      { cardId: 4, concepts: [{ name: "rare", weight: 1 }, { name: "common", weight: 1 }] },
    ];
    // "rare" appears in 2/4 cards, "common" in 4/4 cards -> common has df=totalCards, idf=log(4/4)=0
    const { idfByConcept } = computeIdfWeights(cardConcepts, { frequencyCapFraction: 1 });
    expect(idfByConcept.get("common")).toBe(0);
    expect(idfByConcept.get("rare")).toBeGreaterThan(0);
    expect(idfByConcept.get("rare")).toBeLessThanOrEqual(1);
  });

  it("strongly reduces influence of concepts above the frequency cap", () => {
    // "everywhere" appears in 5/5 cards (100%, well above the 30% cap);
    // "sometimes" appears in 2/5 cards (40%, only slightly above the cap).
    const cardConcepts: CardConcepts[] = [
      { cardId: 0, concepts: [{ name: "everywhere", weight: 1 }, { name: "sometimes", weight: 1 }] },
      { cardId: 1, concepts: [{ name: "everywhere", weight: 1 }, { name: "sometimes", weight: 1 }] },
      { cardId: 2, concepts: [{ name: "everywhere", weight: 1 }] },
      { cardId: 3, concepts: [{ name: "everywhere", weight: 1 }] },
      { cardId: 4, concepts: [{ name: "everywhere", weight: 1 }] },
    ];
    const { weights } = computeIdfWeights(cardConcepts, { frequencyCapFraction: 0.3 });
    const everywhereWeights = weights.filter((w) => w.concept === "everywhere");
    const sometimesWeights = weights.filter((w) => w.concept === "sometimes");
    const avg = (ws: typeof weights) => ws.reduce((s, w) => s + w.q, 0) / ws.length;
    // "everywhere" (df=5/5=100%, capped) should end up with much lower q than "sometimes" (df=2/5=40%, also capped but less so)
    expect(avg(everywhereWeights)).toBeLessThan(avg(sometimesWeights));
  });

  it("computes q = weight * idf for a normal (non-capped, non-unique) concept", () => {
    const cardConcepts: CardConcepts[] = [
      { cardId: 1, concepts: [{ name: "target", weight: 0.5 }] },
      { cardId: 2, concepts: [{ name: "target", weight: 0.5 }] },
      { cardId: 3, concepts: [{ name: "filler", weight: 1 }] },
      { cardId: 4, concepts: [{ name: "filler", weight: 1 }] },
      { cardId: 5, concepts: [{ name: "filler", weight: 1 }] },
      { cardId: 6, concepts: [{ name: "filler", weight: 1 }] },
    ];
    const { weights, idfByConcept } = computeIdfWeights(cardConcepts, { frequencyCapFraction: 1 });
    const target = weights.find((w) => w.concept === "target" && w.cardId === 1);
    expect(target?.q).toBeCloseTo(0.5 * idfByConcept.get("target")!);
  });

  it("returns empty results for an empty input", () => {
    const { weights, idfByConcept, documentFrequency } = computeIdfWeights([]);
    expect(weights).toEqual([]);
    expect(idfByConcept.size).toBe(0);
    expect(documentFrequency.size).toBe(0);
  });
});
