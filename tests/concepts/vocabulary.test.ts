import { describe, expect, it } from "vitest";
import { extractVocabularyConcepts, PORTUGUESE_FUNCTION_WORDS } from "../../src/concepts/vocabulary.js";

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

  it("keeps function words by default", () => {
    const concepts = extractVocabularyConcepts("the dog");
    expect(concepts.some((c) => c.name === "the")).toBe(true);
  });

  it("drops function words when excludeFunctionWords is set", () => {
    const concepts = extractVocabularyConcepts("the dog and the cat", { excludeFunctionWords: true });
    expect(concepts.some((c) => c.name === "the")).toBe(false);
    expect(concepts.some((c) => c.name === "and")).toBe(false);
    expect(concepts.map((c) => c.name).sort()).toEqual(["cat", "dog"]);
  });

  it("uses a custom function-word set (e.g. Portuguese) instead of the English default", () => {
    const concepts = extractVocabularyConcepts("o cachorro e o gato", {
      excludeFunctionWords: true,
      functionWords: PORTUGUESE_FUNCTION_WORDS,
    });
    expect(concepts.map((c) => c.name).sort()).toEqual(["cachorro", "gato"]);
  });

  it("does not drop Portuguese function words when the English set is used (default)", () => {
    const concepts = extractVocabularyConcepts("o cachorro e o gato", { excludeFunctionWords: true });
    expect(concepts.map((c) => c.name).sort()).toEqual(["cachorro", "e", "gato", "o"]);
  });

  it("tokenizes accented Portuguese words correctly", () => {
    const concepts = extractVocabularyConcepts("A administração pública é ótima", {
      excludeFunctionWords: true,
      functionWords: PORTUGUESE_FUNCTION_WORDS,
    });
    expect(concepts.map((c) => c.name).sort()).toEqual(["administração", "pública", "ótima"]);
  });
});
