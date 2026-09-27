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

/**
 * Standard closed-class Portuguese function words (articles, prepositions,
 * pronouns, conjunctions, ser/estar/ter/haver auxiliary forms) — the
 * Portuguese counterpart to ENGLISH_FUNCTION_WORDS, for decks whose studied
 * content is in Portuguese. Not exhaustive; same closed-class coverage
 * rationale as the English list.
 */
export const PORTUGUESE_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "o", "a", "os", "as", "um", "uma", "uns", "umas",
  "de", "em", "para", "por", "com", "sem", "sobre", "entre", "até", "desde", "contra", "perante", "após", "ante", "sob", "trás",
  "e", "mas", "ou", "nem", "pois", "porque", "que", "se", "quando", "como", "enquanto", "embora", "portanto", "logo", "então", "porém", "todavia", "contudo", "caso",
  "eu", "tu", "ele", "ela", "nós", "vós", "eles", "elas", "me", "te", "lhe", "lhes", "nos", "vos", "lo", "la", "los", "las",
  "meu", "minha", "meus", "minhas", "teu", "tua", "teus", "tuas", "seu", "sua", "seus", "suas", "nosso", "nossa", "nossos", "nossas",
  "este", "esta", "estes", "estas", "esse", "essa", "esses", "essas", "isso", "isto", "aquele", "aquela", "aqueles", "aquelas", "aquilo",
  "quem", "qual", "quais", "cujo", "cuja", "cujos", "cujas",
  "é", "são", "foi", "foram", "era", "eram", "seja", "sejam", "será", "serão", "ser", "sendo", "sido",
  "está", "estão", "esteve", "estavam", "esteja", "estar", "estando", "estado",
  "tem", "têm", "tinha", "tinham", "terá", "terão", "ter", "tendo", "tido",
  "há", "havia", "houve", "haver",
  "não", "sim",
  "aqui", "ali", "lá", "aí", "onde",
  "muito", "muita", "muitos", "muitas", "mais", "menos", "também", "só", "apenas", "ainda", "já", "sempre", "nunca",
  "todo", "toda", "todos", "todas", "outro", "outra", "outros", "outras", "mesmo", "mesma", "mesmos", "mesmas", "algum", "alguma", "alguns", "algumas", "cada", "qualquer",
]);

export interface ExtractVocabularyOptions {
  /** Drop function words (articles, prepositions, pronouns, auxiliaries, ...) from the result. */
  excludeFunctionWords?: boolean;
  /** Function-word set to use when `excludeFunctionWords` is set. Defaults to ENGLISH_FUNCTION_WORDS. */
  functionWords?: ReadonlySet<string>;
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
  const functionWords = options.functionWords ?? ENGLISH_FUNCTION_WORDS;
  const filtered = options.excludeFunctionWords
    ? [...words].filter((w) => !functionWords.has(w))
    : [...words];
  return filtered.map((name) => ({ name, weight: 1 }));
}
