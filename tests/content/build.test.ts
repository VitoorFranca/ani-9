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
  it("splits the first field as front and the rest as back, joining both into text", () => {
    const col = collection({
      notes: [{ id: 1, guid: "g", modelId: 1, tags: [], fields: ["<b>Hello</b>", "World[sound:x.mp3]"] }],
      cards: [{ id: 10, noteId: 1, deckId: 1, ord: 0 }],
    });
    const [card] = buildNormalizedCards(col);
    expect(card?.front).toBe("Hello");
    expect(card?.back).toBe("World");
    expect(card?.text).toBe("Hello World");
    expect(card?.contentless).toBe(false);
  });

  it("joins fields past the second into back for note types with more than 2 fields", () => {
    const col = collection({
      notes: [{ id: 1, guid: "g", modelId: 1, tags: [], fields: ["Occlusion", "Image", "Header", "Comments"] }],
      cards: [{ id: 10, noteId: 1, deckId: 1, ord: 0 }],
    });
    const [card] = buildNormalizedCards(col);
    expect(card?.front).toBe("Occlusion");
    expect(card?.back).toBe("Image Header Comments");
  });

  it("skips a leading id-only field (no letters) and an image field to find the real front content", () => {
    // Reproduces data/English.apkg's "4000 EEW Extra" note type exactly:
    // field 0 is a bare sequence id, field 1 an image, field 2 the actual word.
    const col = collection({
      notes: [
        {
          id: 1,
          guid: "g",
          modelId: 1,
          tags: [],
          fields: ["1_1_1", '<img src="hair.jpg">', "hair", "[hɛə]", "[sound:hair1.wav]"],
        },
      ],
      cards: [{ id: 10, noteId: 1, deckId: 1, ord: 0 }],
    });
    const [card] = buildNormalizedCards(col);
    expect(card?.front).toBe("hair");
    expect(card?.back).toContain("1_1_1");
    expect(card?.back).toContain("[hɛə]");
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
      { cardId: 1, noteId: 100, ord: 0, front: "a", back: "", text: "a", contentless: false },
      { cardId: 2, noteId: 100, ord: 1, front: "b", back: "", text: "b", contentless: false },
      { cardId: 3, noteId: 200, ord: 0, front: "c", back: "", text: "c", contentless: false },
    ];
    const grouped = groupCardsByNote(cards);
    expect(grouped.get(100)?.map((c) => c.cardId)).toEqual([1, 2]);
    expect(grouped.get(200)?.map((c) => c.cardId)).toEqual([3]);
  });
});
