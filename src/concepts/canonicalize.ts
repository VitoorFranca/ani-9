import type Anthropic from "@anthropic-ai/sdk";
import { cosineSimilarity, type TextEmbedder } from "../embeddings/embed.js";
import { runLlmBatchWithSplitting } from "./llm-batch.js";
import type { MinimalAnthropicClient } from "./anthropic-client.js";
import { DEFAULT_MODEL } from "./extract.js";

export interface ConceptCandidatePair {
  a: string;
  b: string;
  similarity: number;
}

export interface MergeDecision extends ConceptCandidatePair {
  merge: boolean;
  reason?: string;
}

export interface ConceptMerge {
  canonical: string;
  mergedFrom: string[];
}

export interface CanonicalizationStats {
  candidatePairs: number;
  batches: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  failedPairs: { pair: string; error: string }[];
}

export interface CanonicalizationResult {
  canonicalNameByOriginal: Map<string, string>;
  merges: ConceptMerge[];
  /** Every candidate pair the LLM actually ruled on (merge=true or false), for audit. */
  decisions: MergeDecision[];
  stats: CanonicalizationStats;
}

/**
 * For each concept, finds its `k` nearest neighbors by embedding cosine
 * similarity (a ranking, not an absolute threshold — see canonicalize.ts's
 * module doc for why a fixed threshold doesn't work on short label text),
 * and returns the deduplicated set of candidate pairs across the whole
 * vocabulary.
 */
export async function findCandidatePairs(
  names: readonly string[],
  embedder: TextEmbedder,
  k = 3,
): Promise<ConceptCandidatePair[]> {
  if (names.length < 2) return [];

  const { vectors } = await embedder.embed(names, "query");
  const seen = new Map<string, ConceptCandidatePair>();

  for (let i = 0; i < names.length; i++) {
    const neighbors = vectors
      .map((v, j) => (j === i ? null : { j, similarity: cosineSimilarity(vectors[i]!, v) }))
      .filter((x): x is { j: number; similarity: number } => x !== null)
      .sort((x, y) => y.similarity - x.similarity)
      .slice(0, k);

    for (const { j, similarity } of neighbors) {
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (!seen.has(key)) {
        const [a, b] = i < j ? [names[i]!, names[j]!] : [names[j]!, names[i]!];
        seen.set(key, { a, b, similarity });
      }
    }
  }

  return [...seen.values()].sort((x, y) => y.similarity - x.similarity);
}

function buildMergeTool(): Anthropic.Tool {
  return {
    name: "confirm_merges",
    description: "Decide which candidate concept-name pairs refer to the exact same concept.",
    input_schema: {
      type: "object",
      properties: {
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "integer" },
              merge: { type: "boolean" },
              reason: { type: "string" },
            },
            required: ["index", "merge"],
          },
        },
      },
      required: ["decisions"],
    },
  };
}

function buildMergePrompt(pairs: readonly ConceptCandidatePair[]): string {
  const lines = pairs
    .map((p, i) => `${i}. "${p.a}" <-> "${p.b}" (embedding similarity: ${p.similarity.toFixed(3)})`)
    .join("\n");

  return `You are auditing candidate concept-name merges for a spaced-repetition study app's diagnostic model. An embedding model flagged each pair below as similar, but embedding similarity alone is NOT reliable for this decision on short label-style text — judge by meaning only.

Merge a pair ONLY when both names refer to the EXACT SAME concept from the learner's point of view: getting a card wrong because of one would be diagnostically indistinguishable from getting a card wrong because of the other.

NEVER merge:
- Related but distinct vocabulary a learner must separately know (e.g. "dog" and "puppy", or "carro" and "automóvel" in a language deck — knowing one doesn't mean knowing the other).
- Opposites or contrasting items, even if grammatically parallel (e.g. "my" and "your").
- Items in the same category that are still separately testable facts (e.g. two different historical dates, two different chemical elements, two different irregular verbs' conjugations).

DO merge:
- True duplicates: the same fact/rule/word under two different labels (e.g. spelling/formatting variants, or redundant phrasing of the identical grammar rule).

When in doubt, reject the merge — a missed merge only keeps two diagnoses separate; an incorrect merge corrupts the signal for both concepts.

For each numbered pair, decide merge=true or merge=false, with a short reason.

Pairs:
${lines}`;
}

function validateMergeResult(
  input: unknown,
  pairs: readonly ConceptCandidatePair[],
): { index: number; merge: boolean; reason?: string }[] {
  if (typeof input !== "object" || input === null || !("decisions" in input)) {
    throw new Error("Invalid merge result: missing 'decisions'");
  }
  const decisions = (input as { decisions: unknown }).decisions;
  if (!Array.isArray(decisions)) throw new Error("Invalid merge result: 'decisions' is not an array");
  if (decisions.length !== pairs.length) {
    throw new Error(`Expected ${pairs.length} decisions, got ${decisions.length}`);
  }

  for (const d of decisions) {
    if (typeof d !== "object" || d === null) throw new Error("Invalid decision entry");
    const dd = d as { index?: unknown; merge?: unknown };
    if (typeof dd.index !== "number" || dd.index < 0 || dd.index >= pairs.length) {
      throw new Error("Invalid or out-of-range index");
    }
    if (typeof dd.merge !== "boolean") throw new Error("Invalid merge boolean");
  }

  return decisions as { index: number; merge: boolean; reason?: string }[];
}

export interface ConfirmMergesOptions {
  client: MinimalAnthropicClient;
  model?: string;
  batchSize?: number;
  maxRetriesPerBatch?: number;
  sleep?: (ms: number) => Promise<void>;
}

function pairKey(pair: ConceptCandidatePair): string {
  return `${pair.a}\u0000${pair.b}`;
}

/** Asks the LLM to confirm/reject each candidate pair, in batches. */
export async function confirmMergeCandidates(
  pairs: readonly ConceptCandidatePair[],
  options: ConfirmMergesOptions,
): Promise<{ decisions: MergeDecision[]; stats: CanonicalizationStats }> {
  const model = options.model ?? DEFAULT_MODEL;
  const batchSize = options.batchSize ?? 30;
  const maxRetriesPerBatch = options.maxRetriesPerBatch ?? 2;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const decisions: MergeDecision[] = [];
  const stats: CanonicalizationStats = {
    candidatePairs: pairs.length,
    batches: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    failedPairs: [],
  };

  for (let i = 0; i < pairs.length; i += batchSize) {
    const batch = pairs.slice(i, i + batchSize);
    stats.batches++;

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
      toolName: "confirm_merges",
      itemId: (pair) => pairKey(pair),
      buildTool: buildMergeTool,
      buildPrompt: buildMergePrompt,
      parse: (input, subPairs) => {
        const raw = validateMergeResult(input, subPairs);
        const map = new Map<string, MergeDecision>();
        for (const d of raw) {
          const pair = subPairs[d.index]!;
          const decision: MergeDecision = { ...pair, merge: d.merge };
          if (d.reason !== undefined) decision.reason = d.reason;
          map.set(pairKey(pair), decision);
        }
        return map;
      },
    });

    decisions.push(...results.values());
    stats.failedPairs.push(...failed.map((f) => ({ pair: f.ids.join(", "), error: f.error })));
  }

  return { decisions, stats };
}

export interface CanonicalizationOptions {
  embedder: TextEmbedder;
  client: MinimalAnthropicClient;
  model?: string;
  /** Nearest neighbors per concept to propose as merge candidates. */
  neighborCount?: number;
  batchSize?: number;
  maxRetriesPerBatch?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Canonicalizes concept names via a hybrid pipeline: embeddings propose the
 * top-k nearest-neighbor candidates for each concept (a ranking, not a fixed
 * similarity threshold), and the LLM confirms or rejects each candidate
 * under a strict "same concept from the learner's perspective" criterion.
 *
 * A fixed cosine-similarity threshold was tried first and abandoned: on
 * short concept-label text with Xenova/multilingual-e5-small, true synonyms
 * (e.g. "carro"/"automóvel", sim=0.90) and unrelated pairs (e.g. "carro"/
 * "casa", sim=0.88) overlap enough that no threshold separates them
 * reliably — confirmed against a real deck before switching approaches.
 *
 * Only LLM-confirmed pairs feed the union-find merge; every candidate
 * (confirmed or rejected) is kept in `decisions` for audit.
 */
export async function canonicalizeConcepts(
  conceptCounts: ReadonlyMap<string, number>,
  options: CanonicalizationOptions,
): Promise<CanonicalizationResult> {
  const names = [...conceptCounts.keys()];
  if (names.length === 0) {
    return {
      canonicalNameByOriginal: new Map(),
      merges: [],
      decisions: [],
      stats: { candidatePairs: 0, batches: 0, calls: 0, inputTokens: 0, outputTokens: 0, failedPairs: [] },
    };
  }

  const candidates = await findCandidatePairs(names, options.embedder, options.neighborCount ?? 3);
  const { decisions, stats } = await confirmMergeCandidates(candidates, options);

  const indexByName = new Map(names.map((n, i) => [n, i]));
  const parent = names.map((_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (const decision of decisions) {
    if (!decision.merge) continue;
    const ia = indexByName.get(decision.a);
    const ib = indexByName.get(decision.b);
    if (ia === undefined || ib === undefined) continue;
    union(ia, ib);
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < names.length; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(i);
    else groups.set(root, [i]);
  }

  const canonicalNameByOriginal = new Map<string, string>();
  const merges: ConceptMerge[] = [];

  for (const indices of groups.values()) {
    const groupNames = indices.map((i) => names[i]!);
    groupNames.sort((a, b) => {
      const freqDiff = (conceptCounts.get(b) ?? 0) - (conceptCounts.get(a) ?? 0);
      return freqDiff !== 0 ? freqDiff : a.localeCompare(b);
    });

    const canonical = groupNames[0]!;
    for (const name of groupNames) canonicalNameByOriginal.set(name, canonical);

    if (groupNames.length > 1) {
      merges.push({ canonical, mergedFrom: groupNames.slice(1) });
    }
  }

  return { canonicalNameByOriginal, merges, decisions, stats };
}
