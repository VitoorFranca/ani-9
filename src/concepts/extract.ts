import type Anthropic from "@anthropic-ai/sdk";
import { ConceptCache, hashCardContent } from "./cache.js";
import { runLlmBatchWithSplitting } from "./llm-batch.js";
import type { MinimalAnthropicClient } from "./anthropic-client.js";
import type { ExtractedConcept } from "./types.js";

export type { MinimalAnthropicClient } from "./anthropic-client.js";

export const DEFAULT_MODEL = "claude-haiku-4-5";
const MAX_CONCEPTS_PER_CARD = 6;
/**
 * Bumped whenever buildExtractionPrompt's instructions change in a way that
 * would produce different concepts for the same card text — folded into the
 * cache key so a prompt change can't silently serve stale cached results
 * (e.g. "v1" produced compound labels like "Pretérito imperfeito (acabava)";
 * "v2" requires atomic, single-idea concepts instead).
 */
const EXTRACTION_PROMPT_VERSION = "v2-atomic";

export interface ExtractableCard {
  cardId: number;
  text: string;
}

interface RawExtractionResult {
  cards: { card_id: number; concepts: { name: string; weight: number }[] }[];
}

function clampWeight(w: number): number {
  return Math.min(1, Math.max(1e-6, w));
}

function validateExtractionResult(input: unknown): RawExtractionResult {
  if (typeof input !== "object" || input === null || !("cards" in input)) {
    throw new Error("Invalid extraction result: missing 'cards'");
  }
  const cards = (input as { cards: unknown }).cards;
  if (!Array.isArray(cards)) throw new Error("Invalid extraction result: 'cards' is not an array");

  for (const card of cards) {
    if (typeof card !== "object" || card === null) throw new Error("Invalid card entry");
    const c = card as { card_id?: unknown; concepts?: unknown };
    if (typeof c.card_id !== "number") throw new Error("Invalid or missing card_id");
    if (!Array.isArray(c.concepts)) throw new Error("Invalid or missing concepts array");
    if (c.concepts.length > MAX_CONCEPTS_PER_CARD) {
      throw new Error(`Card ${c.card_id} returned more than ${MAX_CONCEPTS_PER_CARD} concepts`);
    }
    for (const concept of c.concepts) {
      if (typeof concept !== "object" || concept === null) throw new Error("Invalid concept entry");
      const co = concept as { name?: unknown; weight?: unknown };
      if (typeof co.name !== "string" || co.name.trim() === "") throw new Error("Invalid concept name");
      if (typeof co.weight !== "number" || !Number.isFinite(co.weight)) throw new Error("Invalid concept weight");
    }
  }

  return input as RawExtractionResult;
}

function buildExtractionPrompt(cards: readonly ExtractableCard[], knownConcepts: readonly string[]): string {
  const knownList = knownConcepts.length > 0 ? knownConcepts.join(", ") : "(none yet)";
  const cardLines = cards.map((c) => `Card ${c.cardId}: ${c.text}`).join("\n");

  return `You are analyzing flashcards from a spaced-repetition study app. The user writes their own cards, about any subject. For each card, extract the underlying concepts a learner must know to answer it correctly.

Aim for a level of granularity useful for diagnosing WHY a specific card might be answered wrong later — not a broad subject label (e.g. "English", "programming", "history"), and not something so narrow it only ever applies to this one card's exact wording. A good concept is reusable: the same word, grammar rule, formula, date, or fact, named consistently so it can be recognized across different cards.

Rules:
- Each concept must be ATOMIC: it expresses exactly ONE idea — either a grammar/pattern rule, OR a single specific vocabulary item — never both combined into one label, and never a bare parenthetical example tacked onto a rule name. If a card involves both a grammar rule and a specific word/fact, extract them as TWO separate concepts.
  - BAD: "Pretérito imperfeito (acabava)" (mixes a tense rule with one specific verb) — GOOD: "Pretérito imperfeito" and, separately, "verbo acabar".
  - BAD: "Vocabulário: fazendeiro, esposa" (bundles two unrelated words) — GOOD: "fazendeiro" and "esposa" as two separate concepts.
  - BAD: "Adjetivo predicativo (bonita)" — GOOD: "adjetivo predicativo" (grammar) and "bonita" (vocabulary), separately.
- If a concept you're about to name is a close match for one already used in this deck (listed below), reuse that EXACT name instead of creating a near-duplicate.
- "weight" is a number in (0, 1]: how central this concept is to answering the card correctly. 1.0 = the entire card hinges on it; lower values are supporting/secondary concepts.
- Return between 1 and ${MAX_CONCEPTS_PER_CARD} concepts per card. Atomic decomposition often means more concepts than a bundled label would, but never exceed ${MAX_CONCEPTS_PER_CARD}.
- Name concepts in the same language as the card's own content, not translated into English.

Concepts already used in this deck (reuse when applicable):
${knownList}

Cards:
${cardLines}`;
}

function buildExtractionTool(): Anthropic.Tool {
  return {
    name: "extract_concepts",
    description: "Extract the underlying concepts needed to answer each flashcard correctly.",
    input_schema: {
      type: "object",
      properties: {
        cards: {
          type: "array",
          items: {
            type: "object",
            properties: {
              card_id: { type: "integer" },
              concepts: {
                type: "array",
                minItems: 1,
                maxItems: MAX_CONCEPTS_PER_CARD,
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    weight: { type: "number" },
                  },
                  required: ["name", "weight"],
                },
              },
            },
            required: ["card_id", "concepts"],
          },
        },
      },
      required: ["cards"],
    },
  };
}

export interface ExtractConceptsOptions {
  client: MinimalAnthropicClient;
  model?: string;
  cacheDir?: string;
  /**
   * Cards per LLM call. The spec calls for 20-50, but real cards + up to 6
   * concepts each can push output past max_tokens at that size (confirmed:
   * a real run at batchSize=40/max_tokens=4096 truncated half its batches).
   * 15 leaves comfortable headroom under max_tokens=8192; the recursive
   * split-on-truncation below is a safety net on top of that, not a
   * substitute for it.
   */
  batchSize?: number;
  maxRetriesPerBatch?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FailedBatch {
  cardIds: number[];
  error: string;
}

export interface ExtractConceptsStats {
  totalCards: number;
  cacheHits: number;
  batches: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  failedBatches: FailedBatch[];
}

export interface ExtractConceptsResult {
  conceptsByCard: Map<number, ExtractedConcept[]>;
  stats: ExtractConceptsStats;
}

/**
 * Extracts concepts for each card via the Anthropic API, in batches, reusing
 * previously-seen concept names across batches and caching by
 * hash(model, card text) so unchanged cards are never re-sent.
 */
export async function extractConcepts(
  cards: readonly ExtractableCard[],
  options: ExtractConceptsOptions,
): Promise<ExtractConceptsResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const batchSize = options.batchSize ?? 15;
  const maxRetriesPerBatch = options.maxRetriesPerBatch ?? 2;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const cache = new ConceptCache(options.cacheDir ?? "./cache/concepts");

  const conceptsByCard = new Map<number, ExtractedConcept[]>();
  const stats: ExtractConceptsStats = {
    totalCards: cards.length,
    cacheHits: 0,
    batches: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    failedBatches: [],
  };

  const cacheKeyModel = `${model}::${EXTRACTION_PROMPT_VERSION}`;
  const pending: (ExtractableCard & { hash: string })[] = [];
  for (const card of cards) {
    const hash = hashCardContent(cacheKeyModel, card.text);
    const cached = await cache.get(hash);
    if (cached) {
      conceptsByCard.set(card.cardId, cached);
      stats.cacheHits++;
    } else {
      pending.push({ ...card, hash });
    }
  }

  const knownConcepts = new Set<string>([...conceptsByCard.values()].flat().map((c) => c.name));

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    stats.batches++;
    const knownAtBatchStart = [...knownConcepts];

    const { results, failed } = await runLlmBatchWithSplitting(batch, {
      client: options.client,
      model,
      maxOutputTokens: 8192,
      maxRetries: maxRetriesPerBatch,
      sleep,
      onUsage: (usage) => {
        stats.inputTokens += usage.inputTokens;
        stats.outputTokens += usage.outputTokens;
      },
      onAttempt: () => stats.calls++,
      toolName: "extract_concepts",
      itemId: (card) => card.cardId,
      buildTool: buildExtractionTool,
      buildPrompt: (items) => buildExtractionPrompt(items, knownAtBatchStart),
      parse: (input) => {
        const parsed = validateExtractionResult(input);
        const results = new Map<number, ExtractedConcept[]>();
        for (const card of parsed.cards) {
          results.set(
            card.card_id,
            card.concepts.map((c) => ({ name: c.name.trim(), weight: clampWeight(c.weight) })),
          );
        }
        return results;
      },
    });

    stats.failedBatches.push(...failed.map((f) => ({ cardIds: f.ids, error: f.error })));

    for (const card of batch) {
      const concepts = results.get(card.cardId) ?? [];
      conceptsByCard.set(card.cardId, concepts);
      if (results.has(card.cardId)) {
        await cache.set(card.hash, concepts);
        for (const c of concepts) knownConcepts.add(c.name);
      }
    }
  }

  return { conceptsByCard, stats };
}
