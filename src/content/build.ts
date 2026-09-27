import type { AnkiCollection } from "../ingest/types.js";
import { normalizeFieldText } from "./normalize.js";
import type { NormalizedCard } from "./types.js";

const HAS_LETTER = /\p{L}/u;

/**
 * `front` is the first field that actually contains letters after
 * normalization — not just `fields[0]`. Confirmed necessary against a real
 * multi-notetype deck (data/English.apkg): one of its note types puts a
 * bare sequence id ("1_1_1") in field 0 and an image in field 1, with the
 * real studied word ("hair") only in field 2. Blindly using fields[0] would
 * have made every such card's "content" a meaningless id string. `back` is
 * every other field (in original order) joined — note types beyond Basic/
 * Cloze (e.g. Image Occlusion's "Header"/"Comments") can carry conceptually
 * useful text past the second field, and joining everything else is safer
 * than guessing further field roles without field-name metadata (see
 * schema.ts for why field names aren't available for the normalized Anki
 * schema).
 */
export function buildNormalizedCards(collection: AnkiCollection): NormalizedCard[] {
  const notesById = new Map(collection.notes.map((n) => [n.id, n]));

  return collection.cards.map((card): NormalizedCard => {
    const note = notesById.get(card.noteId);
    const fields = note?.fields ?? [];
    const normalized = fields.map((f) => normalizeFieldText(f));

    const frontIndex = normalized.findIndex((f) => HAS_LETTER.test(f));
    const front = frontIndex >= 0 ? normalized[frontIndex]! : "";
    const back = normalized
      .filter((_, i) => i !== frontIndex)
      .filter((f) => f.length > 0)
      .join(" ");
    const text = [front, back].filter((f) => f.length > 0).join(" ");

    return {
      cardId: card.id,
      noteId: card.noteId,
      ord: card.ord,
      front,
      back,
      text,
      contentless: text.length === 0,
    };
  });
}
