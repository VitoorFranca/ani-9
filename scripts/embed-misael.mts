// Computes and caches embeddings for every Misael card's front+back text,
// then exits. Does nothing else (no neighbor sets, no model training) —
// split out from the analysis script per explicit instruction, after two
// incidents where loading the embedding model inside the same process as
// the analysis pipeline led to uncontrolled memory growth.
//
// DO NOT RUN without explicit approval. When approved: run in small
// batches, in the foreground, with `node --import tsx scripts/embed-misael.mts`
// (not npx — npx/tsx-cli spawn a process chain that made an earlier orphaned
// run invisible to process monitoring). Embedder's own on-disk cache
// (./cache/embeddings, keyed by hash(model, text)) persists each text's
// vector as soon as it's computed, so a batch boundary is a safe place to
// stop: re-running this script skips every already-cached text and only
// computes the remainder.
import { readdir } from "node:fs/promises";
import { ingestApkgFile } from "../src/ingest/index.ts";
import { buildNormalizedCards } from "../src/content/build.ts";
import { Embedder } from "../src/embeddings/embed.ts";

const DIR = "./data/misael";
const BATCH_SIZE = 50;

console.time("total");

const files = (await readdir(DIR)).filter((f) => f.endsWith(".apkg")).sort();
console.log(`baralhos: ${files.join(", ")}`);

const textByCardId = new Map<number, string>();
for (const file of files) {
  const { collection, reviews } = await ingestApkgFile(`${DIR}/${file}`);
  const normalized = buildNormalizedCards(collection);
  const reviewedCardIds = new Set(reviews.map((r) => r.cardId));
  for (const c of normalized) {
    if (c.contentless || !reviewedCardIds.has(c.cardId)) continue;
    textByCardId.set(c.cardId, c.text);
  }
}

const cardIds = [...textByCardId.keys()];
console.log(`cartões elegíveis: ${cardIds.length}`);
console.log(`tamanho do lote: ${BATCH_SIZE} (${Math.ceil(cardIds.length / BATCH_SIZE)} lotes)`);

const embedder = new Embedder();

let totalCacheHits = 0;
let totalComputed = 0;
let peakRssBytes = process.memoryUsage().rss;

for (let i = 0; i < cardIds.length; i += BATCH_SIZE) {
  const batchIds = cardIds.slice(i, i + BATCH_SIZE);
  const batchTexts = batchIds.map((id) => textByCardId.get(id)!);

  const t0 = Date.now();
  const result = await embedder.embed(batchTexts, "query");
  const elapsedMs = Date.now() - t0;

  totalCacheHits += result.cacheHits;
  totalComputed += batchTexts.length - result.cacheHits;

  const batchNum = Math.floor(i / BATCH_SIZE) + 1;
  const totalBatches = Math.ceil(cardIds.length / BATCH_SIZE);
  const currentRss = process.memoryUsage().rss;
  peakRssBytes = Math.max(peakRssBytes, currentRss);
  const rssGb = (currentRss / 1e9).toFixed(2);
  console.log(
    `lote ${batchNum}/${totalBatches}: ${batchTexts.length} textos, ${result.cacheHits} do cache, ` +
    `${batchTexts.length - result.cacheHits} computados (${elapsedMs}ms) — RSS=${rssGb}GB`,
  );
}

console.log(`\ntotal: ${cardIds.length} cartões, ${totalCacheHits} já em cache, ${totalComputed} computados agora`);
console.log(`pico de RSS observado: ${(peakRssBytes / 1e9).toFixed(2)}GB`);
console.timeEnd("total");
