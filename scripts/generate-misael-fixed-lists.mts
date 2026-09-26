process.loadEnvFile(".env");
import { mkdirSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { GoogleGenAI } from "@google/genai";
import { ingestApkgFile } from "../src/ingest/index.ts";
import { buildNormalizedCards } from "../src/content/build.ts";
import { selectFixedListSample, generateFixedList, type SampleCard } from "../src/concepts/fixed-list.ts";

const DIR = "./data/misael";
const CACHE_DIR = "./cache";
mkdirSync(CACHE_DIR, { recursive: true });

// Amendment (see MISAEL_CONCEPTS_PROTOCOL.md): all eligible cards for the
// two smaller decks, a 300-card varied sample for the large one.
const SAMPLE_SIZE_BY_FILE: Record<string, number> = {
  "01. Lingua Portuguesa (Geral).apkg": Infinity, // all eligible
  "04. Direito Administrativo.apkg": 300,
  "07. Administracao Publica.apkg": Infinity, // all eligible
};

function safeName(file: string): string {
  return file.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

const client = new GoogleGenAI({});
const files = (await readdir(DIR)).filter((f) => f.endsWith(".apkg")).sort();

let totalInputTokens = 0;
let totalOutputTokens = 0;

for (const file of files) {
  const { collection, reviews } = await ingestApkgFile(`${DIR}/${file}`);
  const normalized = buildNormalizedCards(collection);
  const reviewedCardIds = new Set(reviews.map((r) => r.cardId));
  const eligible = normalized.filter((c) => !c.contentless && reviewedCardIds.has(c.cardId));

  const sampleCards: SampleCard[] = eligible.map((c) => ({ cardId: c.cardId, front: c.front, back: c.back }));
  const requestedSize = SAMPLE_SIZE_BY_FILE[file] ?? 100;
  const sampleSize = Number.isFinite(requestedSize) ? requestedSize : sampleCards.length;
  const sample = selectFixedListSample(sampleCards, sampleSize, 42);

  console.log(`\n${"=".repeat(78)}`);
  console.log(`${file} — amostra: ${sample.length} cartões (de ${eligible.length} elegíveis)`);
  console.log("=".repeat(78));

  const result = await generateFixedList(sample, { client, includeCountTarget: false });
  totalInputTokens += result.usage.inputTokens;
  totalOutputTokens += result.usage.outputTokens;

  console.log(`conceitos gerados: ${result.concepts.length}`);
  console.log(`tokens: entrada=${result.usage.inputTokens} saída=${result.usage.outputTokens}`);
  const cost = (result.usage.inputTokens / 1e6) * 0.25 + (result.usage.outputTokens / 1e6) * 1.5;
  console.log(`custo desta chamada: $${cost.toFixed(5)}`);

  for (const c of result.concepts) {
    console.log(`  - ${c.name}: ${c.description} (exemplos: ${c.examples.join(", ")})`);
  }

  // Coverage estimate from the sample's own citations only (real coverage
  // needs classification, not run yet — see MISAEL_CONCEPTS_PROTOCOL.md).
  const citedCardIds = new Set<number>();
  for (const c of result.concepts) for (const id of c.examples) citedCardIds.add(id);
  const coveragePct = (citedCardIds.size / sample.length) * 100;
  console.log(`estimativa de cobertura (só pelos exemplos citados na amostra): ${citedCardIds.size}/${sample.length} (${coveragePct.toFixed(1)}%)`);

  const cachePath = `${CACHE_DIR}/misael-fixed-list-${safeName(file)}.json`;
  writeFileSync(cachePath, JSON.stringify({ file, concepts: result.concepts }, null, 2));
  console.log(`salvo em: ${cachePath}`);
}

const totalCost = (totalInputTokens / 1e6) * 0.25 + (totalOutputTokens / 1e6) * 1.5;
console.log(`\n${"=".repeat(78)}`);
console.log(`TOTAL (esta rodada): entrada=${totalInputTokens} saída=${totalOutputTokens} custo=$${totalCost.toFixed(5)}`);
console.log(`TOTAL acumulado (incl. 1a rodada, $0.01217): $${(totalCost + 0.01217).toFixed(5)}`);
console.log("=".repeat(78));
