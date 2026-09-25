export interface NormalizedCard {
  cardId: number;
  noteId: number;
  ord: number;
  /** All note fields, normalized and joined. Empty for contentless cards. */
  text: string;
  /** True when the card has no useful text after normalization (media-only). */
  contentless: boolean;
}
