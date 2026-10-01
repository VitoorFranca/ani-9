import { describe, expect, it } from "vitest";
import { classifyAttempt } from "../../src/study/cue.js";
import type { Exposure, Relation } from "../../src/study/types.js";

const cue = (from: number, to: number, status: "active" | "removed" = "active"): Relation<number> => ({
  from,
  to,
  kind: "cue",
  origin: "local",
  status,
  version: 1,
});
const shown = (cardId: number, sessionKey: string, shownAt = 0): Exposure<number> => ({ cardId, sessionKey, shownAt });

describe("classifyAttempt", () => {
  it("is supported when a card revealing the answer was shown earlier in the same session", () => {
    expect(classifyAttempt(1, { sessionKey: "s1", exposures: [shown(2, "s1")] }, [cue(2, 1)])).toBe("supported");
  });

  it("is independent when the revealing card was shown in another session", () => {
    expect(classifyAttempt(1, { sessionKey: "s2", exposures: [shown(2, "s1")] }, [cue(2, 1)])).toBe("independent");
  });

  it("is independent when the relation was removed", () => {
    expect(classifyAttempt(1, { sessionKey: "s1", exposures: [shown(2, "s1")] }, [cue(2, 1, "removed")])).toBe("independent");
  });

  it("only counts cue relations pointing at the answered card", () => {
    expect(classifyAttempt(1, { sessionKey: "s1", exposures: [shown(2, "s1")] }, [cue(1, 2)])).toBe("independent");
  });

  it("ignores prerequisite relations", () => {
    const prereq: Relation<number> = { ...cue(2, 1), kind: "prerequisite" };
    expect(classifyAttempt(1, { sessionKey: "s1", exposures: [shown(2, "s1")] }, [prereq])).toBe("independent");
  });

  it("does not count the card's own earlier exposure", () => {
    expect(classifyAttempt(1, { sessionKey: "s1", exposures: [shown(1, "s1")] }, [cue(1, 1)])).toBe("independent");
  });
});
