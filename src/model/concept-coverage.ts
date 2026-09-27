/**
 * For each concept, the set of distinct note ids among the cards it applies
 * to. Sibling cards from the same note (e.g. cloze ords) trivially share
 * identical or near-identical content, so a concept that only ever links
 * cards from ONE note provides no genuine cross-note transfer signal — it's
 * at best "this note's siblings agree with each other," not "this concept
 * generalizes across the deck."
 */
export function computeConceptNoteCoverage(
  conceptsByCard: ReadonlyMap<number, readonly string[]>,
  noteIdByCard: ReadonlyMap<number, number>,
): Map<string, Set<number>> {
  const coverage = new Map<string, Set<number>>();
  for (const [cardId, concepts] of conceptsByCard) {
    const noteId = noteIdByCard.get(cardId);
    if (noteId === undefined) continue;
    for (const concept of concepts) {
      const notes = coverage.get(concept);
      if (notes) notes.add(noteId);
      else coverage.set(concept, new Set([noteId]));
    }
  }
  return coverage;
}

/** Concepts whose cards all belong to a single note — no cross-note link. */
export function sameNoteOnlyConcepts(noteCoverage: ReadonlyMap<string, ReadonlySet<number>>): Set<string> {
  const flagged = new Set<string>();
  for (const [concept, notes] of noteCoverage) {
    if (notes.size <= 1) flagged.add(concept);
  }
  return flagged;
}

/** Returns a copy of conceptsByCard with the given concept names removed from every card. */
export function removeConcepts(
  conceptsByCard: ReadonlyMap<number, readonly string[]>,
  toRemove: ReadonlySet<string>,
): Map<number, string[]> {
  const result = new Map<number, string[]>();
  for (const [cardId, concepts] of conceptsByCard) {
    result.set(
      cardId,
      concepts.filter((c) => !toRemove.has(c)),
    );
  }
  return result;
}
