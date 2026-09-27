import { describe, expect, it } from "vitest";
import { classifyAttemptCue } from "../src/study/index.js";
import type { CardRelation } from "../src/study/index.js";

const hint: CardRelation = {
  id: "hint", beforeCardId: "b", afterCardId: "a", kind: "answer_hint",
  reason: "B entrega a resposta de A", version: 1, active: true,
};

describe("immediate cue", () => {
  it("flags a revealed answer earlier in the same session", () => {
    expect(classifyAttemptCue("a", "today", 20,
      [{ cardId: "b", sessionId: "today", revealedAt: 10 }], [hint])).toEqual({
      hadImmediateCue: true, relations: [{ id: "hint", version: 1 }],
    });
  });

  it("does not mistake earlier sessions or later reveals for immediate cues", () => {
    const events = [
      { cardId: "b", sessionId: "yesterday", revealedAt: 1 },
      { cardId: "b", sessionId: "today", revealedAt: 30 },
    ];
    expect(classifyAttemptCue("a", "today", 20, events, [hint]).hadImmediateCue).toBe(false);
  });

  it("ignores context relations and deactivated hints", () => {
    const exposure = [{ cardId: "b", sessionId: "today", revealedAt: 10 }];
    expect(classifyAttemptCue("a", "today", 20, exposure, [{ ...hint, kind: "context" }]).hadImmediateCue).toBe(false);
    expect(classifyAttemptCue("a", "today", 20, exposure, [hint, { ...hint, version: 2, active: false }]).hadImmediateCue).toBe(false);
  });
});
