export interface ExtractedConcept {
  name: string;
  /** Centrality of this concept to the card, in (0, 1]. */
  weight: number;
}

export interface CardConcepts {
  cardId: number;
  concepts: ExtractedConcept[];
}
