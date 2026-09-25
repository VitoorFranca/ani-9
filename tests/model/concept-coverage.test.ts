import { describe, expect, it } from "vitest";
import {
  computeConceptNoteCoverage,
  removeConcepts,
  sameNoteOnlyConcepts,
} from "../../src/model/concept-coverage.js";

describe("computeConceptNoteCoverage", () => {
  it("counts distinct notes per concept, not distinct cards", () => {
    const conceptsByCard = new Map([
      [1, ["past simple"]],
      [2, ["past simple"]], // sibling of card 1, same note
      [3, ["past simple"]], // different note
    ]);
    const noteIdByCard = new Map([
      [1, 100],
      [2, 100],
      [3, 200],
    ]);
    const coverage = computeConceptNoteCoverage(conceptsByCard, noteIdByCard);
    expect(coverage.get("past simple")).toEqual(new Set([100, 200]));
  });

  it("skips cards with no known note id", () => {
    const conceptsByCard = new Map([[1, ["x"]]]);
    const coverage = computeConceptNoteCoverage(conceptsByCard, new Map());
    expect(coverage.has("x")).toBe(false);
  });
});

describe("sameNoteOnlyConcepts", () => {
  it("flags a concept whose cards all share a single note", () => {
    const coverage = new Map([
      ["shared-across-notes", new Set([100, 200])],
      ["only-note-100", new Set([100])],
    ]);
    const flagged = sameNoteOnlyConcepts(coverage);
    expect(flagged.has("only-note-100")).toBe(true);
    expect(flagged.has("shared-across-notes")).toBe(false);
  });
});

describe("removeConcepts", () => {
  it("strips the given concept names from every card", () => {
    const conceptsByCard = new Map([
      [1, ["a", "b", "c"]],
      [2, ["b"]],
    ]);
    const result = removeConcepts(conceptsByCard, new Set(["b"]));
    expect(result.get(1)).toEqual(["a", "c"]);
    expect(result.get(2)).toEqual([]);
  });

  it("leaves cards with no flagged concepts unchanged", () => {
    const conceptsByCard = new Map([[1, ["a"]]]);
    const result = removeConcepts(conceptsByCard, new Set(["z"]));
    expect(result.get(1)).toEqual(["a"]);
  });
});
