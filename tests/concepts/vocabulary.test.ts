import { describe, expect, it } from "vitest";
import { extractVocabularyConcepts } from "../../src/concepts/vocabulary.js";

describe("extractVocabularyConcepts", () => {
  it("extracts each distinct word as its own concept with weight 1", () => {
    const concepts = extractVocabularyConcepts("She's called off the wedding.");
    expect(concepts).toEqual(
      expect.arrayContaining([
        { name: "she", weight: 1 },
        { name: "s", weight: 1 },
        { name: "called", weight: 1 },
        { name: "off", weight: 1 },
        { name: "the", weight: 1 },
        { name: "wedding", weight: 1 },
      ]),
    );
  });

  it("deduplicates repeated words within the same card", () => {
    const concepts = extractVocabularyConcepts("the cat and the dog");
    expect(concepts.filter((c) => c.name === "the")).toHaveLength(1);
  });

  it("drops purely numeric tokens", () => {
    const concepts = extractVocabularyConcepts("chapter 12 begins");
    expect(concepts.some((c) => c.name === "12")).toBe(false);
    expect(concepts.some((c) => c.name === "chapter")).toBe(true);
  });

  it("returns a single concept for a single-word front", () => {
    expect(extractVocabularyConcepts("hair")).toEqual([{ name: "hair", weight: 1 }]);
  });

  it("returns an empty array for text with no words", () => {
    expect(extractVocabularyConcepts("123 !!!")).toEqual([]);
  });
});
