import { describe, expect, it } from "vitest";
import {
  buildKarlFront,
  buildKarlUserDatasets,
  stripJudgingAnnotations,
  type KarlRawRecord,
} from "../../src/ingest/karl.js";

function record(overrides: Partial<KarlRawRecord> = {}): KarlRawRecord {
  return {
    userId: "1",
    cardId: "100",
    cardText: "This ancient wonder stood in Alexandria",
    timestampMs: 1_000,
    correct: true,
    deckId: "4",
    deckName: "History",
    ...overrides,
  };
}

describe("stripJudgingAnnotations", () => {
  it("removes bracketed judging instructions", () => {
    expect(stripJudgingAnnotations("Simon Bolivar [or Simón José; prompt on El Libertador until read]")).toBe(
      "Simon Bolivar",
    );
  });

  it("leaves plain answers untouched", () => {
    expect(stripJudgingAnnotations("Copernicus")).toBe("Copernicus");
  });

  it("handles multiple bracket groups", () => {
    expect(stripJudgingAnnotations("Foo [alt 1] Bar [alt 2]")).toBe("Foo  Bar");
  });
});

describe("buildKarlFront", () => {
  it("joins question and cleaned answer when a match exists", () => {
    expect(buildKarlFront("Who built this?", "Copernicus [prompt on Nicolaus]")).toBe(
      "Who built this? Copernicus",
    );
  });

  it("falls back to the question alone when there is no answer match", () => {
    expect(buildKarlFront("Who built this?", undefined)).toBe("Who built this?");
  });

  it("falls back to the question alone when the answer is empty after stripping", () => {
    expect(buildKarlFront("Who built this?", "[unclear]")).toBe("Who built this?");
  });
});

describe("buildKarlUserDatasets", () => {
  it("maps correct/incorrect responses to Good/Again ratings", () => {
    const datasets = buildKarlUserDatasets(
      [record({ correct: true }), record({ cardId: "200", correct: false })],
      new Map(),
    );
    const user = datasets.get("1")!;
    expect(user.reviews.map((r) => r.rating)).toEqual([3, 1]);
    expect(user.reviews.every((r) => r.type === 0)).toBe(true);
  });

  it("groups reviews by user independently", () => {
    const datasets = buildKarlUserDatasets(
      [record({ userId: "1" }), record({ userId: "2", cardId: "200" })],
      new Map(),
    );
    expect([...datasets.keys()].sort()).toEqual(["1", "2"]);
    expect(datasets.get("1")!.reviews).toHaveLength(1);
    expect(datasets.get("2")!.reviews).toHaveLength(1);
  });

  it("sorts a user's reviews chronologically regardless of input order", () => {
    const datasets = buildKarlUserDatasets(
      [
        record({ cardId: "100", timestampMs: 3000 }),
        record({ cardId: "100", timestampMs: 1000 }),
        record({ cardId: "100", timestampMs: 2000 }),
      ],
      new Map(),
    );
    expect(datasets.get("1")!.reviews.map((r) => r.id)).toEqual([1000, 2000, 3000]);
  });

  it("builds one NormalizedCard per distinct card_id, using the answer map for the front text", () => {
    const datasets = buildKarlUserDatasets(
      [record({ cardId: "100", cardText: "Question A" })],
      new Map([["100", "Answer A"]]),
    );
    const card = datasets.get("1")!.cards.get(100)!;
    expect(card.front).toBe("Question A Answer A");
    expect(card.text).toBe(card.front);
    expect(card.contentless).toBe(false);
  });

  it("records deck id/name per card without altering them", () => {
    const datasets = buildKarlUserDatasets(
      [record({ cardId: "100", deckId: "4", deckName: "History" })],
      new Map(),
    );
    expect(datasets.get("1")!.deckByCard.get(100)).toEqual({ deckId: 4, deckName: "History" });
  });

  it("keeps a card's history under one entry when the same card is reviewed multiple times", () => {
    const datasets = buildKarlUserDatasets(
      [
        record({ cardId: "100", timestampMs: 1000, correct: false }),
        record({ cardId: "100", timestampMs: 2000, correct: true }),
      ],
      new Map(),
    );
    const user = datasets.get("1")!;
    expect(user.reviews).toHaveLength(2);
    expect(user.reviews.every((r) => r.cardId === 100)).toBe(true);
    expect(user.cards.size).toBe(1);
  });
});
