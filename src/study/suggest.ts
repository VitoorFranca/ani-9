import { buildBm25Index, tokenize as bm25Tokenize } from "../model/bm25.js";
import type { Relation, StudyCard } from "./types.js";

/** Neighbours per card used to build candidate pairs (lab protocol, round 4). */
export const DEFAULT_NEIGHBORS = 5;
/** Share of the target answer's content words that must be written in the revealing card for a cue. */
export const MIN_ANSWER_COVERAGE = 0.5;
const MAX_REASON_WORDS = 15;

export interface CandidatePair<Id> {
  /** Earlier card in created order. */
  a: Id;
  b: Id;
}

/**
 * Unordered pairs made of each card and its `k` best BM25 neighbours (front +
 * answer as document and query), so a language model only judges plausible
 * pairs. Deterministic; `a` is always the earlier card.
 */
export function candidatePairs<Id>(cards: readonly StudyCard<Id>[], k = DEFAULT_NEIGHBORS): CandidatePair<Id>[] {
  const sorted = [...cards].sort((x, y) => x.createdOrder - y.createdOrder);
  const docs = sorted.map((c) => `${c.front} ${c.back}`);
  const index = buildBm25Index(docs);
  const tokens = docs.map((d) => bm25Tokenize(d));
  const seen = new Set<string>();
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < sorted.length; i++) {
    const scored: Array<[number, number]> = [];
    for (let j = 0; j < sorted.length; j++) {
      if (j === i) continue;
      const score = index.scoreAgainst(tokens[i]!, j);
      if (score > 0) scored.push([score, j]);
    }
    scored.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
    for (const [, j] of scored.slice(0, k)) {
      const [lo, hi] = i < j ? [i, j] : [j, i];
      const key = `${lo}:${hi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([lo, hi]);
    }
  }
  pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return pairs.map(([lo, hi]) => ({ a: sorted[lo]!.id, b: sorted[hi]!.id }));
}

export type RevealAnswer = "A" | "B" | "ambos" | "nenhum";
export type BeforeAnswer = "A" | "B" | "nenhum";

/** A language model's answer about one pair (A = `pair.a`, B = `pair.b`). */
export interface PairJudgement {
  revela: RevealAnswer;
  antes: BeforeAnswer;
  motivo: string;
}

const REVEAL = new Set<string>(["A", "B", "ambos", "nenhum"]);
const BEFORE = new Set<string>(["A", "B", "nenhum"]);

export function isPairJudgement(value: unknown): value is PairJudgement {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.revela === "string" && REVEAL.has(v.revela) && typeof v.antes === "string" && BEFORE.has(v.antes) && typeof v.motivo === "string";
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** Lowercased, accent-free content words (function words removed). */
export function contentWords(text: string, functionWords: ReadonlySet<string>): string[] {
  const stop = new Set([...functionWords].map(fold));
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && !stop.has(t));
}

/** Fraction of the distinct content words of `target`'s answer written in `revealer`'s question or answer. */
export function answerCoverage<Id>(revealer: StudyCard<Id>, target: StudyCard<Id>, functionWords: ReadonlySet<string>): number {
  const answer = new Set(contentWords(target.back, functionWords));
  if (answer.size === 0) return 0;
  const text = new Set(contentWords(`${revealer.front} ${revealer.back}`, functionWords));
  let hit = 0;
  for (const word of answer) if (text.has(word)) hit++;
  return hit / answer.size;
}

/**
 * Relations from a model judgement: a cue only when the model says one card
 * reveals the other **and** at least half of the answer is written in the
 * revealing card; a prerequisite whenever the model says one comes first,
 * with its short reason.
 */
export function relationsFromJudgement<Id>(
  pair: CandidatePair<Id>,
  judgement: PairJudgement,
  cards: ReadonlyMap<Id, StudyCard<Id>>,
  functionWords: ReadonlySet<string>,
  origin: Relation<Id>["origin"] = "external",
): Relation<Id>[] {
  const a = cards.get(pair.a);
  const b = cards.get(pair.b);
  if (!a || !b) return [];
  const base = { origin, status: "active" as const, version: 1 };
  const written = (revealer: StudyCard<Id>, target: StudyCard<Id>) =>
    answerCoverage(revealer, target, functionWords) >= MIN_ANSWER_COVERAGE;
  const out: Relation<Id>[] = [];
  if ((judgement.revela === "A" || judgement.revela === "ambos") && written(a, b)) out.push({ from: pair.a, to: pair.b, kind: "cue", ...base });
  if ((judgement.revela === "B" || judgement.revela === "ambos") && written(b, a)) out.push({ from: pair.b, to: pair.a, kind: "cue", ...base });
  if (judgement.antes !== "nenhum") {
    const reason = judgement.motivo.trim().split(/\s+/).filter(Boolean).slice(0, MAX_REASON_WORDS).join(" ");
    const [from, to] = judgement.antes === "A" ? [pair.a, pair.b] : [pair.b, pair.a];
    out.push({ from, to, kind: "prerequisite", ...base, ...(reason ? { reason } : {}) });
  }
  return out;
}

/** Instruction validated in the lab (round 4). Append one `renderPair` per pair. */
export const SUGGESTION_PROMPT = `Você vai analisar pares de flashcards de um mesmo baralho de estudo. Cada cartão tem uma pergunta e uma resposta. Para cada par, responda:

"revela": algum dos cartões entrega a resposta do outro? Isto é, lendo um cartão inteiro (pergunta e resposta), já dá para responder a pergunta do outro sem ter estudado o assunto. Respostas genéricas como "certo", "correto" ou "sim" não contam como entregar a resposta. Opções: "A" (A entrega a resposta de B), "B" (B entrega a resposta de A), "ambos", "nenhum".

"antes": entender um dos cartões é necessário ou muito útil para entender o outro, a ponto de valer a pena estudá-lo primeiro? Apenas mencionar o mesmo nome, órgão ou termo não basta. Opções: "A" (estudar A primeiro), "B" (estudar B primeiro), "nenhum".

"motivo": se "antes" não for "nenhum", uma frase de até 15 palavras, em português, explicando por que um vem antes do outro; senão, texto vazio.

Responda com um array JSON, um objeto por par, no formato {"id": "<id>", "revela": "...", "antes": "...", "motivo": "..."}.`;

export const SUGGESTION_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      revela: { type: "string", enum: ["A", "B", "ambos", "nenhum"] },
      antes: { type: "string", enum: ["A", "B", "nenhum"] },
      motivo: { type: "string" },
    },
    required: ["id", "revela", "antes", "motivo"],
  },
} as const;

export function renderPair<Id>(id: string, pair: CandidatePair<Id>, cards: ReadonlyMap<Id, StudyCard<Id>>): string {
  const a = cards.get(pair.a)!;
  const b = cards.get(pair.b)!;
  return `id: ${id}\nCartão A — Pergunta: ${a.front}\nCartão A — Resposta: ${a.back}\nCartão B — Pergunta: ${b.front}\nCartão B — Resposta: ${b.back}`;
}
