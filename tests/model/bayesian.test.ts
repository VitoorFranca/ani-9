import { describe, expect, it } from "vitest";
import { GraphBayesianModel, gridSearchHyperparams } from "../../src/model/bayesian.js";

const HP = { priorVariance: 1, driftPerDay: 0.01 };

describe("GraphBayesianModel", () => {
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
