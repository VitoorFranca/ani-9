import type { AnkiCollection } from "../ingest/types.js";
import { normalizeFieldText } from "./normalize.js";
import type { NormalizedCard } from "./types.js";

/**
 * Builds one NormalizedCard per raw card. `front` is the first field;
 * `back` is every remaining field joined — note types beyond Basic/Cloze
 * (e.g. Image Occlusion's "Header"/"Comments") can carry conceptually
 * useful text past the second field, and joining everything after the
 * first is simpler and safer than guessing field roles without field-name
 * metadata (see schema.ts for why field names aren't available for the
 * normalized Anki schema).
 */
export function buildNormalizedCards(collection: AnkiCollection): NormalizedCard[] {
  const notesById = new Map(collection.notes.map((n) => [n.id, n]));

  return collection.cards.map((card): NormalizedCard => {
    const note = notesById.get(card.noteId);
    const fields = note?.fields ?? [];
    const normalized = fields.map((f) => normalizeFieldText(f));

    const front = normalized[0] ?? "";
    const back = normalized
      .slice(1)
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
