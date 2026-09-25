import { tokenize } from "../model/bm25.js";
import type { ExtractedConcept } from "./types.js";

const PURELY_NUMERIC = /^\d+$/;

/**
 * A small, standard English function-word list (articles, prepositions,
 * pronouns, conjunctions, common auxiliary verb forms) — words that are
 * almost always non-diagnostic as standalone vocabulary concepts, since
 * every card in an English deck contains several of them regardless of
 * what's actually being taught. Not exhaustive; covers the closed classes
 * that dominate frequency counts (articles, prepositions, pronouns,
 * conjunctions, be/have/do/modal auxiliaries).
 */
export const ENGLISH_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the",
  "and", "but", "or", "nor", "so", "yet", "if", "because", "as", "while", "although", "than", "that",
  "of", "to", "in", "on", "at", "by", "for", "with", "about", "against", "between", "into", "through",
  "during", "before", "after", "above", "below", "from", "up", "down", "over", "under", "again", "further",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "this", "these", "those",
  "who", "whom", "which", "what",
  "am", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "having",
  "do", "does", "did", "doing",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  "not", "no",
  "there", "here", "then", "once",
  "very", "just", "also", "only", "own", "same", "such", "both", "each", "few", "more", "most", "other", "some", "any", "all",
]);

export interface ExtractVocabularyOptions {
  /** Drop function words (articles, prepositions, pronouns, auxiliaries, ...) from the result. */
  excludeFunctionWords?: boolean;
}

/**
 * Extracts vocabulary concepts from a card's studied-language text by rule,
 * no LLM: every distinct word in `front` becomes its own concept, named
 * exactly as it appears (lowercased), since for vocabulary the word itself
 * IS the concept — unlike grammar/pattern concepts, there's nothing to
 * translate or paraphrase. Purely numeric tokens are dropped (not "words").
 * Every vocabulary concept gets weight 1: centrality doesn't vary by
 * definition (whether a card teaches "hair" is not a matter of degree).
 */
export function extractVocabularyConcepts(
  front: string,
  options: ExtractVocabularyOptions = {},
): ExtractedConcept[] {
  const words = new Set(tokenize(front).filter((w) => !PURELY_NUMERIC.test(w)));
  const filtered = options.excludeFunctionWords
    ? [...words].filter((w) => !ENGLISH_FUNCTION_WORDS.has(w))
    : [...words];
  return filtered.map((name) => ({ name, weight: 1 }));
}
