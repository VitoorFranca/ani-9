import { readFile } from "node:fs/promises";
import { parquetReadObjects } from "hyparquet";
import { parse as parseCsv } from "csv-parse/sync";
import type { NormalizedCard } from "../content/types.js";
import type { Review } from "./types.js";

/** One row of the KARL parquet, after extracting only the fields this pipeline needs. */
export interface KarlRawRecord {
  userId: string;
  cardId: string;
  cardText: string;
  timestampMs: number;
  /** true = correct (maps to Good), false = incorrect (maps to Again). */
  correct: boolean;
  deckId: string;
  deckName: string;
}

export async function loadKarlParquet(path: string): Promise<KarlRawRecord[]> {
  const buf = await readFile(path);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const rows = (await parquetReadObjects({ file: arrayBuffer })) as Array<{
    user_id: string;
    card_id: string;
    card_text: string;
    utc_datetime: Date;
    response: boolean;
    deck_id: string;
    deck_name: string;
  }>;

  return rows.map((r) => ({
    userId: r.user_id,
    cardId: r.card_id,
    cardText: r.card_text,
    timestampMs: r.utc_datetime.getTime(),
    correct: r.response,
    deckId: r.deck_id,
    deckName: r.deck_name,
  }));
}

/**
 * facts.csv (Pinafore/fact-repetition, MIT-licensed code) keys the same
 * quiz-bowl questions by `fact_id`, which matches KARL's `card_id` for
 * 18662/18663 distinct cards (verified against real data — see
 * KARL_PROTOCOL.md). It adds the `answer` column KARL itself never has.
 */
export async function loadFactAnswers(csvPath: string): Promise<Map<string, string>> {
  const raw = await readFile(csvPath, "utf-8");
  const records = parseCsv(raw, { columns: true, skip_empty_lines: true }) as Array<{
    fact_id: string;
    answer: string;
  }>;

  const byFactId = new Map<string, string>();
  for (const record of records) {
    byFactId.set(record.fact_id, record.answer);
  }
  return byFactId;
}

/**
 * facts.csv answers sometimes carry quiz-bowl judging instructions in
 * brackets (e.g. "Simon Bolivar [or Simón ...; prompt on El Libertador
 * until read]") — not part of the answer's content, so stripped before the
 * text feeds vocabulary extraction.
 */
export function stripJudgingAnnotations(answer: string): string {
  return answer.replace(/\[[^\]]*\]/g, "").trim();
}

/**
 * Front text per the pre-registered protocol decision (KARL_PROTOCOL.md):
 * question + answer when a matching fact_id exists, question alone
 * otherwise (only 1/18663 cards lack a match).
 */
export function buildKarlFront(cardText: string, rawAnswer: string | undefined): string {
  const question = cardText.trim();
  if (!rawAnswer) return question;
  const answer = stripJudgingAnnotations(rawAnswer);
  return answer ? `${question} ${answer}` : question;
}

export interface KarlDeckInfo {
  deckId: number;
  deckName: string;
}

export interface KarlUserDataset {
  userId: string;
  reviews: Review[];
  cards: Map<number, NormalizedCard>;
  deckByCard: Map<number, KarlDeckInfo>;
}

/**
 * Groups raw KARL records by user and builds the shared domain types
 * (`Review`, `NormalizedCard`) the rest of the pipeline (fsrs/replay,
 * concepts/vocabulary, model/bayesian) already consumes.
 *
 * KARL has no Anki-style revlog `type` (Learning/Review/Relearning/
 * Filtered/Manual/Rescheduled) — every row is already a genuine study
 * event with a clean boolean outcome, so `revlog-filter.ts`'s Anki-specific
 * reset/cramming logic doesn't apply. `Review.type` is set to 0
 * (Learning-step) for every row so `buildTrainingItems` (fsrs/optimize.ts),
 * which requires a card's kept history to start with type 0, treats every
 * card's full history as usable — correct here since the dataset records
 * each user-card pair from its first exposure (`is_new_fact`).
 *
 * A card's identity is the (user, real KARL card_id) pair: KARL's card_id
 * is a fact shared across users, but FSRS memory state is per-user, so
 * each user gets an independent `NormalizedCard`/review history keyed by
 * the numeric KARL card_id (safe to reuse directly since datasets are
 * processed one user at a time, never pooled).
 */
export function buildKarlUserDatasets(
  records: readonly KarlRawRecord[],
  answerByCardId: ReadonlyMap<string, string>,
): Map<string, KarlUserDataset> {
  const byUser = new Map<string, KarlRawRecord[]>();
  for (const record of records) {
    const forUser = byUser.get(record.userId);
    if (forUser) {
      forUser.push(record);
    } else {
      byUser.set(record.userId, [record]);
    }
  }

  const datasets = new Map<string, KarlUserDataset>();

  for (const [userId, userRecords] of byUser) {
    const sorted = [...userRecords].sort((a, b) => a.timestampMs - b.timestampMs);

    const reviews: Review[] = [];
    const cards = new Map<number, NormalizedCard>();
    const deckByCard = new Map<number, KarlDeckInfo>();

    for (const record of sorted) {
      const numericCardId = Number(record.cardId);

      reviews.push({
        id: record.timestampMs,
        cardId: numericCardId,
        rating: record.correct ? 3 : 1,
        type: 0,
      });

      if (!cards.has(numericCardId)) {
        const front = buildKarlFront(record.cardText, answerByCardId.get(record.cardId));
        cards.set(numericCardId, {
          cardId: numericCardId,
          noteId: numericCardId,
          ord: 0,
          front,
          back: "",
          text: front,
          contentless: front.length === 0,
        });
        deckByCard.set(numericCardId, {
          deckId: Number(record.deckId),
          deckName: record.deckName,
        });
      }
    }

    datasets.set(userId, { userId, reviews, cards, deckByCard });
  }

  return datasets;
}
