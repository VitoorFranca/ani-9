import type Anthropic from "@anthropic-ai/sdk";
import { ConceptCache, hashCardContent } from "./cache.js";
import type { ExtractedConcept } from "./types.js";

export const DEFAULT_MODEL = "claude-haiku-4-5";

export interface ExtractableCard {
  cardId: number;
  text: string;
}

/**
 * Only the shape extract.ts actually needs from an Anthropic client — a
 * real `Anthropic` instance satisfies this structurally, but tests can pass
 * a lightweight mock instead of hitting the network/spending money.
 */
export interface MinimalAnthropicClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      tools: Anthropic.Tool[];
      tool_choice: Anthropic.ToolChoiceTool;
      messages: { role: "user"; content: string }[];
    }): Promise<Anthropic.Message>;
  };
}

interface ExtractionUsage {
  inputTokens: number;
  outputTokens: number;
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
- If a concept you're about to name is a close match for one already used in this deck (listed below), reuse that EXACT name instead of creating a near-duplicate.
- "weight" is a number in (0, 1]: how central this concept is to answering the card correctly. 1.0 = the entire card hinges on it; lower values are supporting/secondary concepts.
- Return between 1 and 6 concepts per card (typically 2-4).
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

async function extractBatch(
  client: MinimalAnthropicClient,
  model: string,
  cards: readonly ExtractableCard[],
  knownConcepts: readonly string[],
  onUsage: (usage: ExtractionUsage) => void,
): Promise<Map<number, ExtractedConcept[]>> {
  const message = await client.messages.create({
    model,
    max_tokens: 4096,
    tools: [buildExtractionTool()],
    tool_choice: { type: "tool", name: "extract_concepts" },
    messages: [{ role: "user", content: buildExtractionPrompt(cards, knownConcepts) }],
  });

  onUsage({ inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse) throw new Error("Model response did not include a tool_use block");

  const parsed = validateExtractionResult(toolUse.input);
  const results = new Map<number, ExtractedConcept[]>();
  for (const card of parsed.cards) {
    results.set(
      card.card_id,
      card.concepts.map((c) => ({ name: c.name.trim(), weight: clampWeight(c.weight) })),
    );
  }
  return results;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; baseDelayMs: number; sleep: (ms: number) => Promise<void>; onAttempt?: () => void },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    opts.onAttempt?.();
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < opts.retries) {
        await opts.sleep(opts.baseDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

export interface ExtractConceptsOptions {
  client: MinimalAnthropicClient;
  model?: string;
  cacheDir?: string;
  /** Cards per LLM call; spec calls for 20-50. */
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
 * hash(model, card text) so unchanged cards are never re-sent. A batch that
 * fails validation is retried with backoff; one that still fails after
 * retries is recorded in `stats.failedBatches` and its cards get no
 * concepts, without aborting the rest of the pipeline.
 */
export async function extractConcepts(
  cards: readonly ExtractableCard[],
  options: ExtractConceptsOptions,
): Promise<ExtractConceptsResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const batchSize = options.batchSize ?? 40;
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

  const pending: (ExtractableCard & { hash: string })[] = [];
  for (const card of cards) {
    const hash = hashCardContent(model, card.text);
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

    try {
      const results = await withRetry(
        () => extractBatch(options.client, model, batch, [...knownConcepts], (usage) => {
          stats.inputTokens += usage.inputTokens;
          stats.outputTokens += usage.outputTokens;
        }),
        { retries: maxRetriesPerBatch, baseDelayMs: 1000, sleep, onAttempt: () => stats.calls++ },
      );

      for (const card of batch) {
        const concepts = results.get(card.cardId) ?? [];
        conceptsByCard.set(card.cardId, concepts);
        await cache.set(card.hash, concepts);
        for (const c of concepts) knownConcepts.add(c.name);
      }
    } catch (error) {
      stats.failedBatches.push({
        cardIds: batch.map((c) => c.cardId),
        error: error instanceof Error ? error.message : String(error),
      });
      for (const card of batch) conceptsByCard.set(card.cardId, []);
    }
  }

  return { conceptsByCard, stats };
}
