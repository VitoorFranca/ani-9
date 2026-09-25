import { describe, expect, it } from "vitest";
import { buildNormalizedCards } from "../../src/content/build.js";
import { groupCardsByNote } from "../../src/content/siblings.js";
import type { AnkiCollection } from "../../src/ingest/types.js";

function collection(overrides: Partial<AnkiCollection> = {}): AnkiCollection {
  return {
    noteTypes: new Map(),
    notes: [],
    cards: [],
    revlog: [],
    ...overrides,
  };
}

describe("buildNormalizedCards", () => {
  it("joins and normalizes all fields of the note", () => {
    const col = collection({
      notes: [{ id: 1, guid: "g", modelId: 1, tags: [], fields: ["<b>Hello</b>", "World[sound:x.mp3]"] }],
      cards: [{ id: 10, noteId: 1, deckId: 1, ord: 0 }],
    });
    const [card] = buildNormalizedCards(col);
    expect(card?.text).toBe("Hello World");
    expect(card?.contentless).toBe(false);
  });

  it("marks a card contentless when only media remains after normalization", () => {
    const col = collection({
      notes: [{ id: 1, guid: "g", modelId: 1, tags: [], fields: ['<img src="a.png">', "[sound:x.mp3]"] }],
      cards: [{ id: 10, noteId: 1, deckId: 1, ord: 0 }],
    });
    const [card] = buildNormalizedCards(col);
    expect(card?.text).toBe("");
    expect(card?.contentless).toBe(true);
  });

  it("produces one distinct card per cloze ord sharing the same resolved text", () => {
    const col = collection({
      notes: [{ id: 1, guid: "g", modelId: 1, tags: [], fields: ["{{c1::My}} car is {{c2::blue}}.", ""] }],
      cards: [
        { id: 10, noteId: 1, deckId: 1, ord: 0 },
        { id: 11, noteId: 1, deckId: 1, ord: 1 },
      ],
    });
    const cards = buildNormalizedCards(col);
    expect(cards).toHaveLength(2);
    expect(cards[0]?.text).toBe("My car is blue.");
    expect(cards[1]?.text).toBe("My car is blue.");
  });

  it("handles a card whose note no longer exists gracefully", () => {
    const col = collection({
      notes: [],
      cards: [{ id: 10, noteId: 999, deckId: 1, ord: 0 }],
    });
    const [card] = buildNormalizedCards(col);
    expect(card?.contentless).toBe(true);
  });
});

describe("groupCardsByNote", () => {
  it("groups sibling cards under their shared note id", () => {
    const cards = [
      { cardId: 1, noteId: 100, ord: 0, text: "a", contentless: false },
      { cardId: 2, noteId: 100, ord: 1, text: "b", contentless: false },
      { cardId: 3, noteId: 200, ord: 0, text: "c", contentless: false },
    ];
    const grouped = groupCardsByNote(cards);
    expect(grouped.get(100)?.map((c) => c.cardId)).toEqual([1, 2]);
    expect(grouped.get(200)?.map((c) => c.cardId)).toEqual([3]);
  });
});
