import { describe, expect, it } from "vitest";
import { effectiveStage, initialProgress, nextStage, STAGE_RULE_VERSION } from "../../src/study/stage.js";
import type { AttemptClass, CardProgress, Rating, Stage } from "../../src/study/types.js";

function at(stage: Stage): CardProgress<number> {
  return { cardId: 1, stage, previousStage: stage, stageSince: "old", ruleVersion: STAGE_RULE_VERSION };
}

// Transition table from specs/003-guided-study/data-model.md.
const table: Array<[Stage, Rating, AttemptClass, Stage]> = [
  ["guided", 1, "independent", "guided"],
  ["guided", 2, "independent", "guided"],
  ["guided", 3, "independent", "reduced"],
  ["guided", 4, "independent", "reduced"],
  ["guided", 3, "supported", "guided"],
  ["reduced", 1, "independent", "guided"],
  ["reduced", 2, "independent", "reduced"],
  ["reduced", 3, "independent", "independent"],
  ["reduced", 3, "supported", "reduced"],
  ["independent", 1, "independent", "reduced"],
  ["independent", 2, "independent", "independent"],
  ["independent", 4, "independent", "retention"],
  ["independent", 3, "supported", "independent"],
  ["retention", 1, "independent", "retention"],
  ["retention", 3, "independent", "retention"],
];

describe("nextStage", () => {
  it.each(table)("%s + rating %i (%s) → %s", (from, rating, attempt, to) => {
    expect(nextStage(at(from), rating, attempt, "s1").stage).toBe(to);
  });

  it("only takes effect from the next session", () => {
    const changed = nextStage(at("guided"), 3, "independent", "s1");
    expect(changed.stage).toBe("reduced");
    expect(effectiveStage(changed, "s1")).toBe("guided");
    expect(effectiveStage(changed, "s2")).toBe("reduced");
  });

  it("does not change twice in the same session", () => {
    const once = nextStage(at("guided"), 3, "independent", "s1");
    expect(nextStage(once, 3, "independent", "s1")).toEqual(once);
  });

  it("keeps the same object shape when nothing changes", () => {
    const p = at("guided");
    expect(nextStage(p, 2, "independent", "s1")).toEqual(p);
  });
});

describe("initialProgress", () => {
  it("starts new cards guided and studied cards at independent recall", () => {
    expect(initialProgress("x", false, "s0").stage).toBe("guided");
    expect(initialProgress("x", true, "s0").stage).toBe("independent");
  });
});
