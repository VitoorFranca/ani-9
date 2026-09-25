import { generateJson, DEFAULT_GEMINI_MODEL, type MinimalGeminiClient } from "./gemini-client.js";

export interface ClassifiableCard {
  cardId: number;
  front: string;
  back: string;
}

function buildClassifyPrompt(cards: readonly ClassifiableCard[], fixedList: readonly string[]): string {
  const listLines = fixedList.map((name, i) => `${i}. ${name}`).join("\n");
  const cardLines = cards
    .map((c) => `Cartão ${c.cardId} — PERGUNTA: ${c.front} — RESPOSTA: ${c.back}`)
    .join("\n");

  return `Você tem uma lista fixa de conceitos (numerados abaixo) e uma lista de flashcards de um aplicativo de repetição espaçada.

Para cada cartão, escolha APENAS os conceitos da lista que esse cartão exige para ser respondido corretamente — pelos números da lista. Um cartão pode não exigir NENHUM conceito da lista (retorne uma lista vazia nesse caso): isso é esperado e correto quando nenhum item da lista se aplica, não force uma escolha.

Não invente conceitos novos — escolha apenas entre os numerados abaixo. Instrução central: julgue pelo CONTEÚDO ESTUDADO no cartão, não pelo idioma em que a pergunta ou a resposta estão escritas — isso vale mesmo quando a resposta é apenas uma tradução de apoio.

Lista de conceitos:
${listLines}

Cartões:
${cardLines}`;
}

function buildClassifySchema(): unknown {
  return {
    type: "object",
    properties: {
      cards: {
        type: "array",
        items: {
          type: "object",
          properties: {
            card_id: { type: "integer" },
            concept_indices: { type: "array", items: { type: "integer" } },
          },
          required: ["card_id", "concept_indices"],
        },
      },
    },
    required: ["cards"],
  };
}

interface RawClassifyResult {
  cards: { card_id: number; concept_indices: number[] }[];
}

function validateClassifyResult(input: unknown, fixedListLength: number): RawClassifyResult {
  if (typeof input !== "object" || input === null || !("cards" in input)) {
    throw new Error("Invalid classify result: missing 'cards'");
  }
  const cards = (input as { cards: unknown }).cards;
  if (!Array.isArray(cards)) throw new Error("Invalid classify result: 'cards' is not an array");

  for (const card of cards) {
    if (typeof card !== "object" || card === null) throw new Error("Invalid card entry");
    const c = card as { card_id?: unknown; concept_indices?: unknown };
    if (typeof c.card_id !== "number") throw new Error("Invalid or missing card_id");
    if (!Array.isArray(c.concept_indices)) throw new Error("Invalid or missing concept_indices");
    for (const idx of c.concept_indices) {
      if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= fixedListLength) {
        throw new Error(`Invalid concept index: ${idx}`);
      }
    }
  }

  return input as RawClassifyResult;
}

async function callWithRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; sleep: (ms: number) => Promise<void> },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < opts.maxRetries) await opts.sleep(1000 * 2 ** attempt);
    }
  }
  throw lastError;
}

export interface ClassifyCardsOptions {
  client: MinimalGeminiClient;
  model?: string;
  /** Ordered concept names; classification responses reference these by index. */
  fixedList: readonly string[];
  batchSize?: number;
  maxRetriesPerBatch?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ClassifyCardsStats {
  totalCards: number;
  batches: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  failedBatches: { cardIds: number[]; error: string }[];
}

export interface ClassifyCardsResult {
  /** Concept NAMES per card (resolved from indices), empty array if none apply. */
  conceptsByCard: Map<number, string[]>;
  stats: ClassifyCardsStats;
}

/**
 * Classifies each card against the FIXED concept list (closed-set choice,
 * "none" allowed) — no new concept names can be created, so there's no
 * canonicalization/merging problem to solve downstream, unlike the earlier
 * open-ended extraction approach.
 */
export async function classifyCards(
  cards: readonly ClassifiableCard[],
  options: ClassifyCardsOptions,
): Promise<ClassifyCardsResult> {
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const batchSize = options.batchSize ?? 30;
  const maxRetriesPerBatch = options.maxRetriesPerBatch ?? 2;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const fixedList = options.fixedList;

  const conceptsByCard = new Map<number, string[]>();
  const stats: ClassifyCardsStats = {
    totalCards: cards.length,
    batches: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    failedBatches: [],
  };

  for (let i = 0; i < cards.length; i += batchSize) {
    const batch = cards.slice(i, i + batchSize);
    stats.batches++;

    try {
      const result = await callWithRetry(
        async () => {
          stats.calls++;
          const response = await generateJson(
            options.client,
            model,
            buildClassifyPrompt(batch, fixedList),
            buildClassifySchema(),
          );
          stats.inputTokens += response.usage.inputTokens;
          stats.outputTokens += response.usage.outputTokens;
          if (!response.text) throw new Error("Empty response from Gemini");
          return validateClassifyResult(JSON.parse(response.text), fixedList.length);
        },
        { maxRetries: maxRetriesPerBatch, sleep },
      );

      for (const card of result.cards) {
        conceptsByCard.set(
          card.card_id,
          card.concept_indices.map((idx) => fixedList[idx]!),
        );
      }
      for (const card of batch) {
        if (!conceptsByCard.has(card.cardId)) conceptsByCard.set(card.cardId, []);
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
