import { tokenize } from "../model/bm25.js";
import { generateJson, DEFAULT_GEMINI_MODEL, type MinimalGeminiClient, type GeminiUsage } from "./gemini-client.js";

export interface SampleCard {
  cardId: number;
  front: string;
  back: string;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/**
 * Selects a varied sample for fixed-list generation, prioritizing phrases
 * (multi-word `front`) over single-word cards — grammar/structural
 * concepts only show up in sentences; a deck full of single vocabulary
 * words (front="hair") has essentially no grammar to discover from.
 * "Phrase" is detected structurally (>1 token in front), not by note type
 * name, consistent with the rest of this project's schema-agnostic design.
 */
export function selectFixedListSample(
  cards: readonly SampleCard[],
  sampleSize = 50,
  seed = 42,
): SampleCard[] {
  const isPhrase = (c: SampleCard) => tokenize(c.front).length > 1;
  const phrases = seededShuffle(cards.filter(isPhrase), seed);
  const singleWords = seededShuffle(cards.filter((c) => !isPhrase(c)), seed + 1);

  const sample = phrases.slice(0, sampleSize);
  if (sample.length < sampleSize) {
    sample.push(...singleWords.slice(0, sampleSize - sample.length));
  }
  return sample;
}

export interface FixedListConcept {
  name: string;
  description: string;
  /** Card IDs from the sample that require this concept (at least 2). */
  examples: number[];
}

function buildFixedListPrompt(cards: readonly SampleCard[]): string {
  const cardLines = cards
    .map((c) => `Cartão ${c.cardId} — PERGUNTA: ${c.front} — RESPOSTA: ${c.back}`)
    .join("\n");

  return `Você está analisando uma amostra de flashcards de um aplicativo de repetição espaçada, para construir uma LISTA FIXA e reutilizável de conceitos, usada depois para classificar TODOS os cartões do baralho.

Instrução central: descreva o CONTEÚDO ESTUDADO — nunca o idioma em que a pergunta ou a resposta estão escritas. Estes cartões têm uma frase em inglês como pergunta e uma tradução em português apenas como apoio à compreensão; o conteúdo estudado é o INGLÊS, não a gramática do português da tradução.

NÃO inclua itens de vocabulário (palavras individuais como "hair" ou "agree") — isso já é coberto por uma regra automática separada. Foque em:
- padrões gramaticais (tempos verbais, estruturas de frase, uso de preposições/conjunções, formação de perguntas/negativas)
- expressões idiomáticas ou phrasal verbs COMO UM TODO no sentido que carregam (ex.: "called off" no sentido de "cancelar"), não como uma junção de palavras soltas
- construções sintáticas recorrentes

Cada conceito deve ser ATÔMICO: uma única ideia por conceito, sem exemplos entre parênteses grudados no nome.
  ERRADO: "past simple (called off)" (mistura a regra gramatical com uma expressão específica)
  CERTO: "past simple" como um conceito, e "phrasal verb: called off" como outro conceito separado (se a expressão em si for relevante o bastante para aparecer em múltiplos cartões).

Critério de granularidade — use-o para decidir quando DIVIDIR uma categoria ampla: dois conceitos são DIFERENTES se uma pessoa pode saber um sem saber o outro. Categorias amplas como "Phrasal Verbs" ou "Expressões Idiomáticas" quase sempre precisam ser divididas nos padrões específicos que os cartões realmente exigem (ex.: em vez de "Phrasal Verbs", use conceitos como "phrasal verb: called off", "phrasal verb: give up", cada um só se aparecer em múltiplos cartões).

Requisitos da lista final:
- Entre 30 e 80 conceitos.
- Cada conceito deve aparecer em PELO MENOS 3 cartões desta amostra — se você só encontrar 1 ou 2 exemplos, ou é específico demais (não deveria estar na lista) ou você precisa generalizar um pouco o conceito até achar um terceiro exemplo real na amostra.
- Para cada conceito, cite os IDs de 2 cartões desta amostra que o exigem (campo "examples"), como prova de que ele realmente aparece repetidamente.

Nomeie os conceitos em português. Para cada um, dê um nome curto, uma descrição de uma frase, e os 2 IDs de exemplo.

Cartões:
${cardLines}`;
}

function buildFixedListSchema(): unknown {
  return {
    type: "object",
    properties: {
      concepts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            examples: { type: "array", items: { type: "integer" } },
          },
          required: ["name", "description", "examples"],
        },
      },
    },
    required: ["concepts"],
  };
}

function validateFixedListResult(input: unknown, validCardIds: ReadonlySet<number>): FixedListConcept[] {
  if (typeof input !== "object" || input === null || !("concepts" in input)) {
    throw new Error("Invalid fixed-list result: missing 'concepts'");
  }
  const concepts = (input as { concepts: unknown }).concepts;
  if (!Array.isArray(concepts)) throw new Error("Invalid fixed-list result: 'concepts' is not an array");

  for (const concept of concepts) {
    if (typeof concept !== "object" || concept === null) throw new Error("Invalid concept entry");
    const c = concept as { name?: unknown; description?: unknown; examples?: unknown };
    if (typeof c.name !== "string" || c.name.trim() === "") throw new Error("Invalid concept name");
    if (typeof c.description !== "string") throw new Error("Invalid concept description");
    if (!Array.isArray(c.examples) || c.examples.length < 2) {
      throw new Error(`Concept "${c.name}" must cite at least 2 example card ids`);
    }
    for (const id of c.examples) {
      if (typeof id !== "number" || !validCardIds.has(id)) {
        throw new Error(`Concept "${c.name}" cites an example card id not in the sample: ${id}`);
      }
    }
  }

  return concepts as FixedListConcept[];
}

export interface GenerateFixedListOptions {
  client: MinimalGeminiClient;
  model?: string;
}

export interface GenerateFixedListResult {
  concepts: FixedListConcept[];
  usage: GeminiUsage;
}

export async function generateFixedList(
  sample: readonly SampleCard[],
  options: GenerateFixedListOptions,
): Promise<GenerateFixedListResult> {
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const result = await generateJson(options.client, model, buildFixedListPrompt(sample), buildFixedListSchema());

  if (!result.text) throw new Error("Empty response from Gemini");
  const validCardIds = new Set(sample.map((c) => c.cardId));
  const concepts = validateFixedListResult(JSON.parse(result.text), validCardIds);

  return { concepts, usage: result.usage };
}
