import { describe, expect, it } from "vitest";
import { planNext } from "../../src/study/planner.js";
import { baselineShadowModel } from "../../src/study/shadow.js";
import type { CardProgress, Relation, SessionContext, Stage, StudyCard } from "../../src/study/types.js";

const card = (id: number): StudyCard<number> => ({ id, front: `q${id}`, back: `a${id}`, createdOrder: id });
const rel = (from: number, to: number, kind: "cue" | "prerequisite"): Relation<number> => ({
  from,
  to,
  kind,
  origin: "local",
  status: "active",
  version: 1,
});
const progress = (cardId: number, stage: Stage): CardProgress<number> => ({
  cardId,
  stage,
  previousStage: stage,
  stageSince: "old",
  ruleVersion: 1,
});

function ctx(partial: Partial<SessionContext<number>>): SessionContext<number> {
  return {
    sessionKey: "s1",
    cards: [card(1), card(2), card(3)],
    relations: [],
    progress: new Map(),
    exposures: [],
    candidates: [1, 2, 3],
    ...partial,
  };
}

describe("planNext", () => {
  it("follows the guided order", () => {
    expect(planNext(ctx({ relations: [rel(3, 1, "prerequisite")] })).cardId).toBe(3);
  });

  it("shows due retention cards first, in the caller's order", () => {
    const decision = planNext(
      ctx({ candidates: [2, 1], progress: new Map([[2, progress(2, "retention")]]), relations: [rel(1, 2, "prerequisite")] }),
    );
    expect(decision.cardId).toBe(2);
  });

  it("in reduced stage, never asks a card right after its cue was shown", () => {
    const decision = planNext(
      ctx({
        candidates: [1, 3],
        relations: [rel(2, 1, "cue")],
        progress: new Map([[1, progress(1, "reduced")]]),
        exposures: [{ cardId: 2, sessionKey: "s1", shownAt: 0 }],
      }),
    );
    expect(decision.cardId).toBe(3);
  });

  it("in independent stage, never asks after any related card was shown", () => {
    const decision = planNext(
      ctx({
        candidates: [1],
        relations: [rel(1, 2, "prerequisite")],
        progress: new Map([[1, progress(1, "independent")]]),
        exposures: [{ cardId: 2, sessionKey: "s1", shownAt: 0 }],
      }),
    );
    expect(decision.cardId).toBeNull();
  });

  it("in guided stage, cues may appear before", () => {
    const decision = planNext(
      ctx({ candidates: [1], relations: [rel(2, 1, "cue")], exposures: [{ cardId: 2, sessionKey: "s1", shownAt: 0 }] }),
    );
    expect(decision.cardId).toBe(1);
  });

  it("returns null when there is nothing to show", () => {
    expect(planNext(ctx({ candidates: [] })).cardId).toBeNull();
  });

  it("explains the choice", () => {
    const decision = planNext(ctx({ relations: [rel(3, 1, "prerequisite")] }));
    expect(decision.reasons.length).toBeGreaterThan(0);
  });
});

describe("baselineShadowModel", () => {
  it("proposes one of the candidates without depending on the planner", () => {
    const context = ctx({ relations: [rel(3, 1, "prerequisite"), rel(3, 2, "prerequisite")] });
    const proposal = baselineShadowModel.propose(context);
    expect(context.candidates).toContain(proposal);
    expect(baselineShadowModel.propose(context)).toBe(proposal);
  });

  it("proposes nothing when there are no candidates", () => {
    expect(baselineShadowModel.propose(ctx({ candidates: [] }))).toBeNull();
  });
});
