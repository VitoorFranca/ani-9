export interface NormalizedCard {
  cardId: number;
  noteId: number;
  ord: number;
  /** First field, normalized (e.g. "Front" on Basic, "Text" on Cloze). */
  front: string;
  /** Remaining fields, normalized and joined (e.g. "Back", or "Back Extra" on Cloze). */
  back: string;
  /** front + back joined. Empty for contentless cards. */
  text: string;
  /** True when the card has no useful text after normalization (media-only). */
  contentless: boolean;
}
