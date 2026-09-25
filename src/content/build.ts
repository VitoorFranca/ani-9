import type { AnkiCollection } from "../ingest/types.js";
import { normalizeFieldText } from "./normalize.js";
import type { NormalizedCard } from "./types.js";

/**
 * Builds one NormalizedCard per raw card. Content is "all fields joined",
 * not just the first two: note types beyond Basic/Cloze (e.g. Image
 * Occlusion's "Header"/"Comments") can carry conceptually useful text in
 * fields past the second, and joining everything is simpler and safer than
 * guessing which fields are "front" and "back" without field-name metadata
 * (see schema.ts for why field names aren't available for the normalized
 * Anki schema).
 */
export function buildNormalizedCards(collection: AnkiCollection): NormalizedCard[] {
  const notesById = new Map(collection.notes.map((n) => [n.id, n]));

  return collection.cards.map((card): NormalizedCard => {
    const note = notesById.get(card.noteId);
    const fields = note?.fields ?? [];
    const text = fields
      .map((f) => normalizeFieldText(f))
      .filter((f) => f.length > 0)
      .join(" ");

    return {
      cardId: card.id,
      noteId: card.noteId,
      ord: card.ord,
      text,
      contentless: text.length === 0,
    };
  });
}
