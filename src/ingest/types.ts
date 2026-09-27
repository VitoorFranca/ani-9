export interface NoteType {
  id: number;
  name: string;
  fields: string[];
}

export interface RawNote {
  id: number;
  guid: string;
  modelId: number;
  tags: string[];
  fields: string[];
}

export interface RawCard {
  id: number;
  noteId: number;
  deckId: number;
  ord: number;
}

export interface RawRevlogEntry {
  id: number;
  cardId: number;
  ease: number;
  factor: number;
  type: number;
}

export interface AnkiCollection {
  noteTypes: Map<number, NoteType>;
  notes: RawNote[];
  cards: RawCard[];
  revlog: RawRevlogEntry[];
}

/**
 * A revlog entry that survived filtering (see revlog-filter.ts): a genuine
 * review the user actually performed, in the order it happened.
 */
export interface Review {
  id: number;
  cardId: number;
  rating: 1 | 2 | 3 | 4;
  type: number;
}
