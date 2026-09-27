import type { NormalizedCard } from "./types.js";

/** Groups sibling cards (cloze ords, or Basic+Reversed pairs) by their shared note. */
export function groupCardsByNote(cards: readonly NormalizedCard[]): Map<number, NormalizedCard[]> {
  const byNote = new Map<number, NormalizedCard[]>();
  for (const card of cards) {
    const siblings = byNote.get(card.noteId);
    if (siblings) {
      siblings.push(card);
    } else {
      byNote.set(card.noteId, [card]);
    }
  }
  return byNote;
}
