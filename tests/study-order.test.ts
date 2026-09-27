import { describe, expect, it } from "vitest";
import { orderGuidedCards, orderStudySession } from "../src/study/index.js";
import type { CardRelation } from "../src/study/index.js";

const relation = (id: string, beforeCardId: string, afterCardId: string): CardRelation => ({
  id, beforeCardId, afterCardId, kind: "context", reason: "apresenta o contexto",
  version: 1, active: true,
});

describe("guided order", () => {
  it("places reviewed prerequisites first and explains why", () => {
    const result = orderGuidedCards([{ id: "application" }, { id: "unrelated" }, { id: "concept" }],
      [relation("r1", "concept", "application")]);
    expect(result.cardIds).toEqual(["unrelated", "concept", "application"]);
    expect(result.reasonsByCardId.application).toEqual([{
      fromCardId: "concept", relation: { id: "r1", version: 1 }, reason: "apresenta o contexto",
    }]);
    expect(result.problems).toEqual([]);
  });

  it("does not schedule cycles or silently drop missing cards", () => {
    const result = orderGuidedCards([{ id: "a" }, { id: "b" }, { id: "free" }], [
      relation("r1", "a", "b"), relation("r2", "b", "a"), relation("r3", "gone", "a"),
    ]);
    expect(result.cardIds).toEqual(["free"]);
    expect(result.problems).toContainEqual({ type: "missing_card", relation: { id: "r3", version: 1 }, cardId: "gone" });
    expect(result.problems).toContainEqual({ type: "cycle", cardIds: ["a", "b"] });
  });

  it("uses the latest revision without rewriting the previous one", () => {
    const first = relation("r", "a", "b");
    const revised = { ...first, version: 2, active: false };
    expect(orderGuidedCards([{ id: "b" }, { id: "a" }], [first, revised]).cardIds).toEqual(["b", "a"]);
  });

  it("keeps an answer hint after a reduced or independent target", () => {
    const hint = { ...relation("hint", "b", "a"), kind: "answer_hint" as const };
    const cards = [{ id: "b" }, { id: "a" }];
    const state = { cardId: "a", stage: "reduced" as const, ruleVersion: 1 as const };
    expect(orderStudySession(cards, [hint], [state]).cardIds).toEqual(["a", "b"]);
    expect(orderStudySession(cards, [hint], [{ ...state, stage: "independent" }]).cardIds).toEqual(["a", "b"]);
  });
});
