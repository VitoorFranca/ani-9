import type { RawRevlogEntry, Review } from "./types.js";

/**
 * Keeps only revlog entries that represent a genuine review the user
 * performed, per Anki's own `reviews_for_fsrs` logic (rslib/src/scheduler/
 * fsrs/params.rs), not merely `ease != 0` or `type` in a fixed set:
 *
 *  - type 4 (Manual) and 5 (Rescheduled): never genuine, always dropped.
 *    Anki forces ease=0 on these, but we don't rely on that.
 *  - type 4 with factor=0 is a "Forget" reset: the card's memory state
 *    restarts, so every entry before it (for that card) is discarded too.
 *  - type 3 (Filtered): kept only if factor != 0 (a genuine, merely
 *    early, review); factor=0 means cramming and is discarded.
 *  - ease <= 0 is dropped defensively regardless of type.
 *
 * Entries that survive are returned in chronological order across all cards.
 */
export function filterRevlog(raw: readonly RawRevlogEntry[]): Review[] {
  const byCard = new Map<number, RawRevlogEntry[]>();
  for (const entry of raw) {
    const forCard = byCard.get(entry.cardId);
    if (forCard) {
      forCard.push(entry);
    } else {
      byCard.set(entry.cardId, [entry]);
    }
  }

  const result: Review[] = [];

  for (const [cardId, entries] of byCard) {
    const sorted = [...entries].sort((a, b) => a.id - b.id);

    let startIndex = 0;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const entry = sorted[i]!;
      if (entry.type === 4 && entry.factor === 0) {
        startIndex = i + 1;
        break;
      }
    }

    for (let i = startIndex; i < sorted.length; i++) {
      const entry = sorted[i]!;
      if (entry.ease <= 0) continue;
      if (entry.type === 4 || entry.type === 5) continue;
      if (entry.type === 3 && entry.factor === 0) continue;

      result.push({
        id: entry.id,
        cardId,
        rating: entry.ease as 1 | 2 | 3 | 4,
        type: entry.type,
      });
    }
  }

  result.sort((a, b) => a.id - b.id);
  return result;
}
