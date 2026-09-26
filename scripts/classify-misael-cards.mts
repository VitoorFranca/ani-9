process.loadEnvFile(".env");
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { GoogleGenAI } from "@google/genai";
import { ingestApkgFile } from "../src/ingest/index.ts";
import { buildNormalizedCards } from "../src/content/build.ts";
import { classifyCards, type ClassifiableCard } from "../src/concepts/classify.ts";
import type { FixedListConcept } from "../src/concepts/fixed-list.ts";

const DIR = "./data/misael";
const CACHE_DIR = "./cache";
mkdirSync(CACHE_DIR, { recursive: true });

function safeName(file: string): string {
  return file.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0; state = (state + 0x6d2b79f5) | 0;
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

const client = new GoogleGenAI({});
const files = (await readdir(DIR)).filter((f) => f.endsWith(".apkg")).sort();

const allConceptsByCard = new Map<number, string[]>();
const cardTextById = new Map<number, { front: string; back: string; file: string }>();
let totalInputTokens = 0;
let totalOutputTokens = 0;

for (const file of files) {
  const cachePath = `${CACHE_DIR}/misael-fixed-list-${safeName(file)}.json`;
  const { concepts } = JSON.parse(readFileSync(cachePath, "utf8")) as { concepts: FixedListConcept[] };
  const fixedList = concepts.map((c) => c.name);

  const { collection, reviews } = await ingestApkgFile(`${DIR}/${file}`);
  const normalized = buildNormalizedCards(collection);
  const reviewedCardIds = new Set(reviews.map((r) => r.cardId));
  const eligible = normalized.filter((c) => !c.contentless && reviewedCardIds.has(c.cardId));

  const classifiable: ClassifiableCard[] = eligible.map((c) => ({ cardId: c.cardId, front: c.front, back: c.back }));
  for (const c of eligible) cardTextById.set(c.cardId, { front: c.front, back: c.back, file });

  console.log(`\n${"=".repeat(78)}`);
  console.log(`${file} — classificando ${classifiable.length} cartões contra ${fixedList.length} conceitos`);
  console.log("=".repeat(78));

  const result = await classifyCards(classifiable, { client, fixedList, batchSize: 30 });
  totalInputTokens += result.stats.inputTokens;
  totalOutputTokens += result.stats.outputTokens;

  for (const [cardId, names] of result.conceptsByCard) allConceptsByCard.set(cardId, names);

  const withConcept = [...result.conceptsByCard.values()].filter((names) => names.length > 0).length;
  const coveragePct = (withConcept / classifiable.length) * 100;
  console.log(`chamadas: ${result.stats.calls}, lotes: ${result.stats.batches}, falhas: ${result.stats.failedBatches.length}`);
  console.log(`tokens: entrada=${result.stats.inputTokens} saída=${result.stats.outputTokens}`);
  const cost = (result.stats.inputTokens / 1e6) * 0.25 + (result.stats.outputTokens / 1e6) * 1.5;
  console.log(`custo desta classificação: $${cost.toFixed(5)}`);
  console.log(`COBERTURA REAL: ${withConcept}/${classifiable.length} cartões com >=1 conceito (${coveragePct.toFixed(1)}%)`);

  if (result.stats.failedBatches.length > 0) {
    console.log(`lotes com falha:`, result.stats.failedBatches);
  }
}

const cachePath = `${CACHE_DIR}/misael-classify-all.json`;
writeFileSync(cachePath, JSON.stringify([...allConceptsByCard.entries()]));
console.log(`\nclassificação pooled salva em: ${cachePath}`);

const totalCost = (totalInputTokens / 1e6) * 0.25 + (totalOutputTokens / 1e6) * 1.5;
console.log(`\n${"=".repeat(78)}`);
console.log(`TOTAL classificação: entrada=${totalInputTokens} saída=${totalOutputTokens} custo=$${totalCost.toFixed(5)}`);
console.log(`TOTAL acumulado (listas $0.03767 + classificação): $${(totalCost + 0.03767).toFixed(5)}`);
console.log("=".repeat(78));

// 20 random cards for audit.
console.log(`\n${"=".repeat(78)}`);
console.log(`Auditoria: 20 cartões aleatórios (seed fixa)`);
console.log("=".repeat(78));
const allCardIds = [...allConceptsByCard.keys()];
const sampleForAudit = seededShuffle(allCardIds, 12345).slice(0, 20);
for (const cardId of sampleForAudit) {
  const text = cardTextById.get(cardId)!;
  const names = allConceptsByCard.get(cardId)!;
  console.log(`\n[${text.file}] cartão=${cardId}`);
  console.log(`  PERGUNTA: ${text.front}`);
  console.log(`  RESPOSTA: ${text.back}`);
  console.log(`  conceitos: ${names.length > 0 ? names.join(", ") : "(nenhum)"}`);
}
