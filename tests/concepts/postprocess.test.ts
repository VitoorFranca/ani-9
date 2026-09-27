import { describe, expect, it } from "vitest";
import { splitCompoundConcepts, splitCompoundLabel } from "../../src/concepts/postprocess.js";

describe("splitCompoundLabel", () => {
  it("leaves a plain label unchanged", () => {
    expect(splitCompoundLabel("fazendeiro")).toEqual(["fazendeiro"]);
  });

  it('splits "X (Y)" into two atomic labels', () => {
    expect(splitCompoundLabel("era casada (pretérito imperfeito)")).toEqual([
      "era casada",
      "pretérito imperfeito",
    ]);
  });

  it('splits "X (Y)" regardless of which side is the grammar term', () => {
    expect(splitCompoundLabel("Pretérito imperfeito (acabava)")).toEqual([
      "Pretérito imperfeito",
      "acabava",
    ]);
  });

  it('splits "/"-separated alternatives into separate labels', () => {
    expect(splitCompoundLabel("estúpido/burro/bobo")).toEqual(["estúpido", "burro", "bobo"]);
  });

  it("applies both rules together: paren split, then slash split on each side", () => {
    expect(splitCompoundLabel("existia/vivia (pretérito imperfeito)")).toEqual([
      "existia",
      "vivia",
      "pretérito imperfeito",
    ]);
  });

  it("does not split a parenthetical that isn't at the end of the string", () => {
    expect(splitCompoundLabel("(nota) verbo irregular")).toEqual(["(nota) verbo irregular"]);
  });

  it("does not split on nested/multiple parenthetical groups", () => {
    expect(splitCompoundLabel("verbo (ser) (irregular)")).toEqual(["verbo (ser)", "irregular"]);
  });

  it("trims whitespace around split parts", () => {
    expect(splitCompoundLabel("verbo   (  ser  )")).toEqual(["verbo", "ser"]);
  });
});

describe("splitCompoundConcepts", () => {
  it("splits compound labels across all cards and reports how many were split", () => {
    const input = new Map([
      [1, [{ name: "era casada (pretérito imperfeito)", weight: 0.9 }, { name: "fazendeiro", weight: 0.5 }]],
      [2, [{ name: "existia/vivia (pretérito imperfeito)", weight: 0.8 }]],
    ]);

    const { conceptsByCard, stats } = splitCompoundConcepts(input);

    expect(conceptsByCard.get(1)).toEqual([
      { name: "era casada", weight: 0.9 },
      { name: "pretérito imperfeito", weight: 0.9 },
      { name: "fazendeiro", weight: 0.5 },
    ]);
    expect(conceptsByCard.get(2)).toEqual([
      { name: "existia", weight: 0.8 },
      { name: "vivia", weight: 0.8 },
      { name: "pretérito imperfeito", weight: 0.8 },
    ]);
    expect(stats).toEqual({ labelsSplit: 2, totalOriginalConcepts: 3, totalAfterSplit: 6 });
  });

  it("deduplicates within a card when splitting produces the same atomic label twice, keeping the max weight", () => {
    const input = new Map([
      [
        1,
        [
          { name: "era casada (pretérito imperfeito)", weight: 0.5 },
          { name: "era velho (pretérito imperfeito)", weight: 0.9 },
        ],
      ],
    ]);

    const { conceptsByCard, stats } = splitCompoundConcepts(input);

    const concepts = conceptsByCard.get(1)!;
    expect(concepts).toContainEqual({ name: "pretérito imperfeito", weight: 0.9 });
    expect(concepts).toContainEqual({ name: "era casada", weight: 0.5 });
    expect(concepts).toContainEqual({ name: "era velho", weight: 0.9 });
    expect(concepts).toHaveLength(3); // "pretérito imperfeito" deduplicated from 2 down to 1
    expect(stats.totalAfterSplit).toBe(3);
  });

  it("leaves cards with no compound labels untouched", () => {
    const input = new Map([[1, [{ name: "fazendeiro", weight: 0.8 }]]]);
    const { conceptsByCard, stats } = splitCompoundConcepts(input);
    expect(conceptsByCard.get(1)).toEqual([{ name: "fazendeiro", weight: 0.8 }]);
    expect(stats).toEqual({ labelsSplit: 0, totalOriginalConcepts: 1, totalAfterSplit: 1 });
  });

  it("handles an empty input", () => {
    const { conceptsByCard, stats } = splitCompoundConcepts(new Map());
    expect(conceptsByCard.size).toBe(0);
    expect(stats).toEqual({ labelsSplit: 0, totalOriginalConcepts: 0, totalAfterSplit: 0 });
  });
});
