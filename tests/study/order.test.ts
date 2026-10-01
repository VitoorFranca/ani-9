import { describe, expect, it } from "vitest";
import { explainPosition, orderCards } from "../../src/study/order.js";
import type { Relation, StudyCard } from "../../src/study/types.js";

function card<Id>(id: Id, createdOrder: number, front = `q${String(id)}`): StudyCard<Id> {
  return { id, front, back: `a${String(id)}`, createdOrder };
}
function prereq<Id>(from: Id, to: Id, status: "active" | "removed" = "active"): Relation<Id> {
  return { from, to, kind: "prerequisite", origin: "local", status, version: 1 };
}

describe("orderCards", () => {
  it("puts a prerequisite before its dependent", () => {
    const cards = [card(1, 0), card(2, 1), card(3, 2)];
    const { order, cycles } = orderCards(cards, [prereq(3, 1)]);
    expect(order.indexOf(3)).toBeLessThan(order.indexOf(1));
    expect(cycles).toEqual([]);
  });

  it("keeps cards without relations in created order", () => {
    const cards = [card(10, 2), card(11, 0), card(12, 1)];
    expect(orderCards(cards, []).order).toEqual([11, 12, 10]);
  });

  it("never invents an order for a cycle: reports it and falls back to created order", () => {
    const cards = [card("a", 0), card("b", 1), card("c", 2)];
    const { order, cycles } = orderCards(cards, [prereq("b", "a"), prereq("a", "b")]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(cycles).toEqual([{ cardIds: ["a", "b"] }]);
  });

  it("ignores relations that point to missing cards and removed relations", () => {
    const cards = [card(1, 0), card(2, 1)];
    const { order } = orderCards(cards, [prereq(99, 1), prereq(2, 1, "removed")]);
    expect(order).toEqual([1, 2]);
  });

  it("ignores cue relations for ordering", () => {
    const cards = [card(1, 0), card(2, 1)];
    const cue: Relation<number> = { from: 2, to: 1, kind: "cue", origin: "local", status: "active", version: 1 };
    expect(orderCards(cards, [cue]).order).toEqual([1, 2]);
  });

  it("gives the same structure for numeric and string ids", () => {
    const numeric = orderCards([card(1, 0), card(2, 1), card(3, 2)], [prereq(3, 1), prereq(2, 3)]);
    const text = orderCards([card("1", 0), card("2", 1), card("3", 2)], [prereq("3", "1"), prereq("2", "3")]);
    expect(text.order).toEqual(numeric.order.map(String));
  });

  it("is deterministic regardless of input order", () => {
    const cards = [card(1, 0), card(2, 1), card(3, 2), card(4, 3)];
    const rels = [prereq(4, 2), prereq(3, 1)];
    const a = orderCards(cards, rels).order;
    const b = orderCards([...cards].reverse(), [...rels].reverse()).order;
    expect(b).toEqual(a);
  });
});

describe("explainPosition", () => {
  it("names the prerequisite in plain language", () => {
    const cards = [card(1, 0, "O que é ato administrativo?"), card(2, 1, "Qual o atributo da presunção de legitimidade?")];
    const reasons = explainPosition(2, cards, [prereq(1, 2)]);
    expect(reasons[0]?.code).toBe("after-prerequisite");
    expect(reasons[0]?.text).toContain("O que é ato administrativo?");
  });

  it("says when a card has no relation", () => {
    expect(explainPosition(1, [card(1, 0)], [])[0]?.code).toBe("none");
  });

  it("flags cycles", () => {
    const cards = [card(1, 0), card(2, 1)];
    const codes = explainPosition(1, cards, [prereq(1, 2), prereq(2, 1)]).map((r) => r.code);
    expect(codes).toContain("cycle");
  });
});
