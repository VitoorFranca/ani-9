import type { ExtractedConcept } from "./types.js";

/**
 * Splits a single concept label into one or more atomic labels,
 * deterministically — a safety net for when the extraction prompt's
 * "atomic concept" instruction isn't followed (confirmed against real data:
 * the model kept producing compound labels like "era casada (pretérito
 * imperfeito)", just with the grammar/vocabulary order flipped from what an
 * earlier prompt version produced).
 *
 * Two rules, applied in order:
 *  1. A trailing parenthetical — "X (Y)" — becomes two labels: "X" and "Y".
 *  2. Any "/"-separated alternatives within a resulting label — "A/B/C" —
 *     become separate labels "A", "B", "C".
 */
export function splitCompoundLabel(name: string): string[] {
  let parts = [name];

  const parenMatch = name.match(/^(.+?)\s*\(([^()]+)\)\s*$/);
  if (parenMatch) {
    parts = [parenMatch[1]!.trim(), parenMatch[2]!.trim()];
  }

  const result: string[] = [];
  for (const part of parts) {
    if (part.includes("/")) {
      for (const alt of part.split("/")) {
        const trimmed = alt.trim();
        if (trimmed.length > 0) result.push(trimmed);
      }
    } else if (part.length > 0) {
      result.push(part);
    }
  }

  return result.length > 0 ? result : [name];
}

export interface SplitCompoundConceptsStats {
  /** How many original labels were split into 2+ atomic labels. */
  labelsSplit: number;
  totalOriginalConcepts: number;
  totalAfterSplit: number;
}

/**
 * Applies splitCompoundLabel across every card's extracted concepts, then
 * deduplicates within each card (a split can produce the same atomic label
 * twice for one card, e.g. two different compound labels both containing
 * "pretérito imperfeito") by keeping the highest weight.
 */
export function splitCompoundConcepts(
  conceptsByCard: ReadonlyMap<number, ExtractedConcept[]>,
): { conceptsByCard: Map<number, ExtractedConcept[]>; stats: SplitCompoundConceptsStats } {
  const result = new Map<number, ExtractedConcept[]>();
  const stats: SplitCompoundConceptsStats = { labelsSplit: 0, totalOriginalConcepts: 0, totalAfterSplit: 0 };

  for (const [cardId, concepts] of conceptsByCard) {
    const expanded: ExtractedConcept[] = [];
    for (const concept of concepts) {
      stats.totalOriginalConcepts++;
      const names = splitCompoundLabel(concept.name);
      if (names.length > 1) stats.labelsSplit++;
      for (const name of names) expanded.push({ name, weight: concept.weight });
    }

    const byName = new Map<string, ExtractedConcept>();
    for (const concept of expanded) {
      const existing = byName.get(concept.name);
      if (!existing || concept.weight > existing.weight) byName.set(concept.name, concept);
    }

    const deduped = [...byName.values()];
    stats.totalAfterSplit += deduped.length;
    result.set(cardId, deduped);
  }

  return { conceptsByCard: result, stats };
}
