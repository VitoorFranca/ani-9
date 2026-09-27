import { describe, expect, it } from "vitest";
import { advanceStudyStage, initialStudyState } from "../src/study/index.js";

describe("study stage rule v1", () => {
  it("fades support across distinct sessions before retention", () => {
    const guided = initialStudyState("a");
    const reduced = advanceStudyStage(guided, 3, true, "s1");
    expect(reduced.stage).toBe("reduced");
    const independent = advanceStudyStage(reduced, 3, false, "s2");
    expect(independent.stage).toBe("independent");
    expect(advanceStudyStage(independent, 3, false, "s3").stage).toBe("retention");
    expect(() => advanceStudyStage(reduced, 3, false, "s1")).toThrow();
  });

  it("holds or steps back after a cue or error", () => {
    const reduced = advanceStudyStage(initialStudyState("a"), 3, false, "s1");
    expect(advanceStudyStage(reduced, 3, true, "s2").stage).toBe("reduced");
    expect(advanceStudyStage(reduced, 1, false, "s2").stage).toBe("guided");
    const independent = advanceStudyStage(reduced, 3, false, "s2");
    expect(advanceStudyStage(independent, 1, false, "s3").stage).toBe("reduced");
    expect(advanceStudyStage(independent, 2, false, "s3").stage).toBe("independent");
  });
});
