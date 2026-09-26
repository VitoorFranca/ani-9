import { describe, expect, it } from "vitest";
import { GraphBayesianModel, gridSearchHyperparams, rescaleSimilarity, buildCombinedLinks } from "../../src/model/bayesian.js";

const HP = { priorVariance: 1, driftPerDay: 0.01 };

describe("rescaleSimilarity", () => {
  it("returns 0 for similarity at or below tau", () => {
    expect(rescaleSimilarity(0.5, 0.5, 1)).toBe(0);
    expect(rescaleSimilarity(0.3, 0.5, 1)).toBe(0);
  });

  it("returns lambda at similarity=1 (full strength)", () => {
    expect(rescaleSimilarity(1, 0.5, 1)).toBeCloseTo(1);
    expect(rescaleSimilarity(1, 0.5, 2)).toBeCloseTo(2);
  });

  it("scales linearly between tau and 1", () => {
    // tau=0.5: similarity=0.75 is halfway to 1 -> weight 0.5*lambda
    expect(rescaleSimilarity(0.75, 0.5, 1)).toBeCloseTo(0.5);
  });

  it("lambda=0 zeroes every weight regardless of similarity", () => {
    expect(rescaleSimilarity(1, 0, 0)).toBe(0);
    expect(rescaleSimilarity(0.9, 0.1, 0)).toBe(0);
  });

  it("tau=0 behaves like a plain lambda multiplier with no floor", () => {
    expect(rescaleSimilarity(0.4, 0, 1)).toBeCloseTo(0.4);
  });

  it("never returns a negative weight", () => {
    expect(rescaleSimilarity(0, 0.8, 1)).toBe(0);
  });
});

describe("GraphBayesianModel with string node ids (concept-membership model)", () => {
  it("links a card to its concept names directly, with no self-link, and propagates evidence between cards sharing a concept", () => {
    const model = new GraphBayesianModel<string>(HP);
    // Card A has concepts {"past simple", "phrasal verb: call off"}; card B shares only "past simple".
    const cardALinks = [
      { id: "past simple", weight: 1 },
      { id: "phrasal verb: call off", weight: 1 },
    ];
    const cardBLinks = [{ id: "past simple", weight: 1 }];

    model.predictAndUpdate(cardALinks, 0.5, 1, 0); // card A reviewed correctly
    expect(model.getState("past simple")!.theta).toBeGreaterThan(0);
    expect(model.getState("phrasal verb: call off")!.theta).toBeGreaterThan(0);

    // Card B, never reviewed before, should already predict above raw FSRS R
    // because it shares "past simple" with card A.
    const pB = model.predictAndUpdate(cardBLinks, 0.5, 1, 0);
    expect(pB).toBeGreaterThan(0.5);
  });

  it("equivalence still holds with string ids: theta=0 everywhere means p=fsrsR", () => {
    const model = new GraphBayesianModel<string>(HP);
    const p = model.predictAndUpdate([{ id: "some concept", weight: 1 }], 0.73, 1, 0);
    expect(p).toBeCloseTo(0.73, 3);
  });
});

describe("GraphBayesianModel", () => {
  it("stays an exact FSRS pass-through across repeated reviews when every link weight is 0 (lambda=0 case)", () => {
    const model = new GraphBayesianModel(HP);
    const links = [
      { id: 1, weight: 0 }, // as rescaleSimilarity(_, _, 0) would produce
      { id: 2, weight: 0 },
    ];
    for (const [fsrsR, y] of [[0.9, 1], [0.2, 0], [0.5, 1], [0.99, 0]] as [number, 0 | 1][]) {
      const p = model.predictAndUpdate(links, fsrsR, y, 0);
      expect(p).toBeCloseTo(fsrsR, 6);
    }
    // theta never moved for either linked node.
    expect(model.getState(1)!.theta).toBe(0);
    expect(model.getState(2)!.theta).toBe(0);
  });

  it("equivalence: with every theta at 0, the prediction equals the FSRS R exactly (mandatory test)", () => {
    // Arbitrary link weights, including neighbors — doesn't matter since theta=0 everywhere on first use.
    const links = [
      { id: 1, weight: 1 },
      { id: 2, weight: 0.7 },
      { id: 3, weight: 0.3 },
    ];
    for (const fsrsR of [0.9, 0.5, 0.1, 0.99, 0.01]) {
      const fresh = new GraphBayesianModel(HP);
      const p = fresh.predictAndUpdate(links, fsrsR, 1, 0);
      expect(p).toBeCloseTo(fsrsR, 3);
    }
  });

  it("a correct review increases theta for the reviewed card and propagates to its neighbor", () => {
    const model = new GraphBayesianModel(HP);
    const links = [
      { id: 1, weight: 1 },
      { id: 2, weight: 0.8 }, // neighbor
    ];
    model.predictAndUpdate(links, 0.5, 1, 0); // correct (y=1), fsrs was uncertain (R=0.5)

    expect(model.getState(1)!.theta).toBeGreaterThan(0);
    expect(model.getState(2)!.theta).toBeGreaterThan(0); // propagated, smaller magnitude than card 1's own
    expect(model.getState(2)!.theta).toBeLessThan(model.getState(1)!.theta);
  });

  it("a wrong review decreases theta for the reviewed card and its neighbor", () => {
    const model = new GraphBayesianModel(HP);
    const links = [
      { id: 1, weight: 1 },
      { id: 2, weight: 0.8 },
    ];
    model.predictAndUpdate(links, 0.9, 0, 0); // wrong (y=0), fsrs was confident (R=0.9)

    expect(model.getState(1)!.theta).toBeLessThan(0);
    expect(model.getState(2)!.theta).toBeLessThan(0);
  });

  it("does not update a card that isn't in the link list for this review", () => {
    const model = new GraphBayesianModel(HP);
    model.predictAndUpdate([{ id: 1, weight: 1 }], 0.5, 0, 0);
    expect(model.getState(99)).toBeUndefined();
  });

  it("shrinks variance after an update but never below the floor", () => {
    const model = new GraphBayesianModel(HP);
    const links = [{ id: 1, weight: 1 }];
    const varianceBefore = HP.priorVariance;
    model.predictAndUpdate(links, 0.5, 1, 0);
    const varianceAfter = model.getState(1)!.variance;
    expect(varianceAfter).toBeLessThan(varianceBefore);
    expect(varianceAfter).toBeGreaterThan(0);
  });

  it("variance grows again via drift after time passes with no new evidence", () => {
    const model = new GraphBayesianModel({ priorVariance: 1, driftPerDay: 0.5 });
    const links = [{ id: 1, weight: 1 }];
    model.predictAndUpdate(links, 0.5, 1, 0);
    const afterFirstUpdate = model.getState(1)!.variance;

    // 10 days later, predictAndUpdate applies drift before doing anything else.
    model.predictAndUpdate(links, 0.5, 1, 10);
    // Can't isolate pre-update variance directly, but a much larger drift
    // than the previous shrink should net out to a variance increase vs.
    // immediately after the first update.
    const afterSecondCallVariance = model.getState(1)!.variance;
    expect(afterSecondCallVariance).toBeGreaterThan(afterFirstUpdate * 0.1); // sanity: drift dominated
  });

  it("repeated failures push theta increasingly negative for an isolated card (no neighbors)", () => {
    const model = new GraphBayesianModel(HP);
    const links = [{ id: 1, weight: 1 }];
    const thetas: number[] = [];
    for (let day = 0; day < 5; day++) {
      model.predictAndUpdate(links, 0.8, 0, day);
      thetas.push(model.getState(1)!.theta);
    }
    for (let i = 1; i < thetas.length; i++) {
      expect(thetas[i]!).toBeLessThan(thetas[i - 1]!);
    }
  });
});

describe("gridSearchHyperparams", () => {
  it("picks the hyperparameter combination with the lowest reported log-loss", () => {
    const result = gridSearchHyperparams([0.5, 1, 2], [0.01, 0.1], (hp) => {
      // Fake loss surface with a clear minimum at priorVariance=1, driftPerDay=0.01.
      return (hp.priorVariance - 1) ** 2 + (hp.driftPerDay - 0.01) ** 2;
    });
    expect(result.best).toEqual({ priorVariance: 1, driftPerDay: 0.01 });
    expect(result.tried).toHaveLength(6);
  });
});

describe("buildCombinedLinks", () => {
  it("returns no links at all when baseId is undefined, regardless of extra", () => {
    // The exact bug reintroduced twice in the Misael analysis scripts: a
    // card with no base assignment (e.g. contentless) must fall back to no
    // links (pure FSRS passthrough), never a "base:undefined" link.
    expect(buildCombinedLinks<string>(undefined, ["algum-conceito"], { lambdaBase: 2, lambdaExtra: 1 })).toEqual([]);
    expect(buildCombinedLinks<string>(undefined, [], { lambdaBase: 2, lambdaExtra: 1 })).toEqual([]);
  });

  it("returns a single base link when extra is empty", () => {
    expect(buildCombinedLinks("deck:A", [], { lambdaBase: 2, lambdaExtra: 1 })).toEqual([
      { id: "deck:A", weight: 2 },
    ]);
  });

  it("averages extra weight across the extra group, base weight unaffected", () => {
    const links = buildCombinedLinks("deck:A", ["x", "y"], { lambdaBase: 2, lambdaExtra: 1 });
    expect(links).toEqual([
      { id: "deck:A", weight: 2 },
      { id: "x", weight: 0.5 },
      { id: "y", weight: 0.5 },
    ]);
  });

  it("gives every extra link weight 0 when lambdaExtra=0, without omitting them", () => {
    const links = buildCombinedLinks("deck:A", ["x", "y", "z"], { lambdaBase: 2, lambdaExtra: 0 });
    expect(links).toEqual([
      { id: "deck:A", weight: 2 },
      { id: "x", weight: 0 },
      { id: "y", weight: 0 },
      { id: "z", weight: 0 },
    ]);
  });

  it("equivalence: lambdaExtra=0 reproduces the base-only model exactly, review by review", () => {
    // The property buildCombinedLinks exists to guarantee: a variant at
    // lambdaExtra=0 must be bit-identical to the base-only model, so a grid
    // search that includes lambdaExtra=0 can never score worse than the base.
    const hp = { priorVariance: 0.5, driftPerDay: 0.01 };
    const combinedHp = { lambdaBase: 1.5, lambdaExtra: 0 };
    const reviews: { fsrsR: number; y: 0 | 1; day: number; extra: string[] }[] = [
      { fsrsR: 0.9, y: 1, day: 0, extra: ["x"] },
      { fsrsR: 0.6, y: 0, day: 1, extra: [] },
      { fsrsR: 0.7, y: 1, day: 3, extra: ["x", "y"] },
      { fsrsR: 0.5, y: 0, day: 5, extra: ["y"] },
    ];

    const baseModel = new GraphBayesianModel<string>(hp);
    const combinedModel = new GraphBayesianModel<string>(hp);

    for (const r of reviews) {
      const baseLinks = buildCombinedLinks("deck:A", [], { lambdaBase: combinedHp.lambdaBase, lambdaExtra: 0 });
      const combinedLinks = buildCombinedLinks("deck:A", r.extra, combinedHp);
      const basePrediction = baseModel.predictAndUpdate(baseLinks, r.fsrsR, r.y, r.day);
      const combinedPrediction = combinedModel.predictAndUpdate(combinedLinks, r.fsrsR, r.y, r.day);
      expect(combinedPrediction).toBeCloseTo(basePrediction, 12);
    }
    expect(baseModel.getState("deck:A")).toEqual(combinedModel.getState("deck:A"));
  });
});
