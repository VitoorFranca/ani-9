import { tokenize } from "../model/bm25.js";
import type { ExtractedConcept } from "./types.js";

const PURELY_NUMERIC = /^\d+$/;

/**
 * Extracts vocabulary concepts from a card's studied-language text by rule,
 * no LLM: every distinct word in `front` becomes its own concept, named
 * exactly as it appears (lowercased), since for vocabulary the word itself
 * IS the concept — unlike grammar/pattern concepts, there's nothing to
 * translate or paraphrase. Purely numeric tokens are dropped (not "words").
 * Every vocabulary concept gets weight 1: centrality doesn't vary by
 * definition (whether a card teaches "hair" is not a matter of degree).
 */
export function extractVocabularyConcepts(front: string): ExtractedConcept[] {
  const words = new Set(tokenize(front).filter((w) => !PURELY_NUMERIC.test(w)));
  return [...words].map((name) => ({ name, weight: 1 }));
}
