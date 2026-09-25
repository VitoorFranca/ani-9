import type { CardConcepts } from "./types.js";

export interface ConceptWeight {
  cardId: number;
  concept: string;
  /** q_ic = weight_ic * idf_c, already frequency-capped; 0 for single-card concepts. */
  q: number;
}

export interface IdfResult {
  weights: ConceptWeight[];
  idfByConcept: Map<string, number>;
  /** How many distinct cards each concept appears in. */
  documentFrequency: Map<string, number>;
}

/**
 * Computes q_ic = weight_ic * idf_c (idf normalized to [0,1]) for every
 * (card, concept) pair. Concepts above `frequencyCapFraction` of all cards
 * have their idf scaled down further (they're too generic to diagnose
 * anything); concepts appearing in exactly one card are kept for audit but
 * given q=0, since a single-card concept can't transfer signal anywhere.
 *
 * `cardConcepts` must already have canonical concept names applied.
 */
export function computeIdfWeights(
  cardConcepts: readonly CardConcepts[],
  opts: { frequencyCapFraction?: number } = {},
): IdfResult {
  const frequencyCapFraction = opts.frequencyCapFraction ?? 0.3;
  const totalCards = cardConcepts.length;

  const documentFrequency = new Map<string, number>();
  for (const cc of cardConcepts) {
    const seen = new Set(cc.concepts.map((c) => c.name));
    for (const name of seen) {
      documentFrequency.set(name, (documentFrequency.get(name) ?? 0) + 1);
    }
  }

  const rawIdf = new Map<string, number>();
  for (const [name, df] of documentFrequency) {
    rawIdf.set(name, Math.log(totalCards / df));
  }
  const maxRawIdf = Math.max(0, ...rawIdf.values());

  const idfByConcept = new Map<string, number>();
  for (const [name, raw] of rawIdf) {
    idfByConcept.set(name, maxRawIdf > 0 ? raw / maxRawIdf : 0);
  }

  const weights: ConceptWeight[] = [];
  for (const cc of cardConcepts) {
    for (const concept of cc.concepts) {
      const df = documentFrequency.get(concept.name) ?? 0;

      if (df <= 1) {
        weights.push({ cardId: cc.cardId, concept: concept.name, q: 0 });
        continue;
      }

      let idf = idfByConcept.get(concept.name) ?? 0;
      const frequencyFraction = totalCards > 0 ? df / totalCards : 0;
      if (frequencyFraction > frequencyCapFraction) {
        idf *= frequencyCapFraction / frequencyFraction;
      }

      weights.push({ cardId: cc.cardId, concept: concept.name, q: concept.weight * idf });
    }
  }

  return { weights, idfByConcept, documentFrequency };
}
