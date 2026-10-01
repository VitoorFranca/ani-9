import { describe, expect, it } from "vitest";
import { answerCoverage, candidatePairs, isPairJudgement, relationsFromJudgement } from "../../src/study/suggest.js";
import type { StudyCard } from "../../src/study/types.js";

const card = (id: number, front: string, back: string): StudyCard<number> => ({ id, front, back, createdOrder: id });
const fw = new Set(["o", "a", "de", "da", "é", "que"]);

describe("candidatePairs", () => {
  const cards = [
    card(1, "o que é ato administrativo", "manifestação unilateral da administração"),
    card(2, "atributos do ato administrativo", "presunção de legitimidade e imperatividade"),
    card(3, "presunção de legitimidade é absoluta", "não, é relativa"),
    card(4, "capital francesa", "paris"),
  ];

  it("pairs each card with its best neighbours, earlier card as A, without duplicates", () => {
    const pairs = candidatePairs(cards, 1);
    expect(pairs).toContainEqual({ a: 1, b: 2 });
    expect(pairs).toContainEqual({ a: 2, b: 3 });
    const keys = pairs.map((p) => `${p.a}-${p.b}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of pairs) expect(p.a).toBeLessThan(p.b);
  });

  it("never pairs cards with nothing in common", () => {
    expect(candidatePairs(cards, 3).some((p) => p.a === 4 || p.b === 4)).toBe(false);
  });

  it("is deterministic regardless of input order", () => {
    expect(candidatePairs([...cards].reverse(), 2)).toEqual(candidatePairs(cards, 2));
  });
});

describe("relationsFromJudgement", () => {
  const army = card(1, "army", "An army is a large group of people who fight in wars");
  const guerilla = card(2, "guerilla", "A guerilla is a person who fights as part of an unofficial army");
  const ato = card(3, "O que é ato administrativo?", "manifestação unilateral da administração");
  const atributo = card(4, "A manifestação unilateral da administração tem quais atributos?", "presunção de legitimidade");
  const byId = new Map([army, guerilla, ato, atributo].map((c) => [c.id, c]));

  it("drops a cue whose answer is not written in the revealing card", () => {
    expect(relationsFromJudgement({ a: 1, b: 2 }, { revela: "A", antes: "nenhum", motivo: "" }, byId, fw)).toEqual([]);
  });

  it("keeps a cue whose answer is written in the revealing card", () => {
    expect(answerCoverage(atributo, ato, fw)).toBe(1);
    expect(relationsFromJudgement({ a: 3, b: 4 }, { revela: "B", antes: "nenhum", motivo: "" }, byId, fw)).toEqual([
      { from: 4, to: 3, kind: "cue", origin: "external", status: "active", version: 1 },
    ]);
  });

  it("keeps a prerequisite with its reason, capped at 15 words", () => {
    const long = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    const [rel] = relationsFromJudgement({ a: 3, b: 4 }, { revela: "nenhum", antes: "B", motivo: long }, byId, fw);
    expect(rel).toMatchObject({ from: 4, to: 3, kind: "prerequisite" });
    expect(rel?.reason?.split(" ")).toHaveLength(15);
  });

  it("returns nothing for missing cards or 'nenhum'", () => {
    expect(relationsFromJudgement({ a: 3, b: 99 }, { revela: "A", antes: "A", motivo: "" }, byId, fw)).toEqual([]);
    expect(relationsFromJudgement({ a: 3, b: 4 }, { revela: "nenhum", antes: "nenhum", motivo: "" }, byId, fw)).toEqual([]);
  });

  it("validates judgements", () => {
    expect(isPairJudgement({ revela: "A", antes: "nenhum", motivo: "" })).toBe(true);
    expect(isPairJudgement({ revela: "talvez", antes: "nenhum", motivo: "" })).toBe(false);
  });
});
