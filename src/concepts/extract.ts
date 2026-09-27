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
 * would produce different concepts for the same card content — folded into
 * the cache key so a prompt change can't silently serve stale cached
 * results. History: "v1" produced compound labels like "Pretérito
 * imperfeito (acabava)"; "v2-atomic" asked for atomic single-idea concepts
 * (only partially followed — real runs still produced ~48% compound labels,
 * fixed downstream by postprocess.ts's deterministic split instead); "v3"
 * fixes a different bug confirmed on real data: with front=English/
 * back=Portuguese-translation cards, extraction kept labeling Portuguese
 * translation-gloss grammar ("pretérito imperfeito") instead of the English
 * content actually being studied. v3 sends front/back separately, labeled
 * PERGUNTA/RESPOSTA, and instructs the model to describe the studied
 * content rather than the language the question or answer happens to be
 * written in.
 */
const EXTRACTION_PROMPT_VERSION = "v3-content-not-language";

export interface ExtractableCard {
  cardId: number;
  front: string;
  back: string;
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
  const knownList = knownConcepts.length > 0 ? knownConcepts.join(", ") : "(nenhum ainda)";
  const cardLines = cards
    .map((c) => `Cartão ${c.cardId} — PERGUNTA: ${c.front} — RESPOSTA: ${c.back}`)
    .join("\n");

  return `Você está analisando flashcards de um aplicativo de repetição espaçada. O usuário cria seus próprios cartões, sobre qualquer assunto. Para cada cartão, liste o conhecimento necessário para acertá-lo.

Instrução central: descreva o CONTEÚDO ESTUDADO no cartão — nunca o idioma em que a pergunta ou a resposta estão escritas. O idioma usado é só o meio; o que importa é o que o cartão está de fato ensinando ou testando. Isso vale mesmo em cartões de idioma: se o cartão ensina uma frase em inglês com uma tradução em português apenas como apoio, o conteúdo estudado é o inglês, não a gramática do português da tradução.

Exemplos corretos e incorretos, em áreas diferentes:

[Idioma — cartão de inglês com tradução em português como apoio]
PERGUNTA: "There was once a farmer and his wife"
RESPOSTA: "Existia (havia) uma vez um fazendeiro e sua esposa"
ERRADO: "pretérito perfeito" (descreve a gramática do PORTUGUÊS da tradução — não é isso que o cartão ensina)
CERTO: "passado narrativo em inglês (there was)", "fazendeiro (farmer)", "esposa (wife)" (descreve o inglês que está sendo estudado)

[Programação — cartão em inglês sobre Python]
PERGUNTA: "What does this return: [x*2 for x in range(5)]?"
RESPOSTA: "[0, 2, 4, 6, 8]"
ERRADO: "gramática do inglês (pergunta interrogativa)" (descreve o idioma da pergunta, não o que o cartão ensina)
CERTO: "list comprehension em Python", "função range()"

[Medicina — cartão em inglês sobre farmacologia]
PERGUNTA: "What is the mechanism of action of metformin?"
RESPOSTA: "Reduces hepatic glucose production and increases insulin sensitivity"
ERRADO: "vocabulário médico em inglês" (ainda descreve o idioma, não o fato médico, e é genérico demais)
CERTO: "mecanismo de ação da metformina", "produção hepática de glicose"

Regras:
- Cada conceito deve ser ATÔMICO: uma única ideia por conceito — ou uma regra/padrão, ou um item específico de vocabulário/fato — nunca os dois juntos, e nunca um exemplo entre parênteses grudado no nome da regra. Se o cartão envolve tanto uma regra quanto um item específico, extraia os DOIS como conceitos separados.
  - ERRADO: "vocabulário: fazendeiro, esposa" (agrupa duas palavras) — CERTO: "fazendeiro" e "esposa" separadamente.
  - ERRADO: "pretérito imperfeito (acabava)" (mistura regra e palavra específica) — CERTO: "pretérito imperfeito" e, separadamente, "verbo acabar".
- Se um conceito que você está prestes a nomear for próximo o suficiente de um já usado neste baralho (listado abaixo), reuse o nome EXATO em vez de criar um quase-duplicado.
- "weight" é um número em (0, 1]: o quanto esse conceito é central para acertar o cartão. 1.0 = o cartão inteiro depende dele; valores menores são conceitos de apoio.
- Retorne entre 1 e ${MAX_CONCEPTS_PER_CARD} conceitos por cartão. Decomposição atômica costuma exigir mais conceitos que um rótulo composto, mas nunca ultrapasse ${MAX_CONCEPTS_PER_CARD}.
- TODOS os nomes de conceito devem estar em português, não importa o idioma do cartão.

Conceitos já usados neste baralho (reuse quando aplicável):
${knownList}

Cartões:
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
 * hash(model, front, back) so unchanged cards are never re-sent.
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
    const hash = hashCardContent(cacheKeyModel, `${card.front}\u0001${card.back}`);
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
