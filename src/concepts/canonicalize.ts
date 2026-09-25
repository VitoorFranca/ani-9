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
  groupVerification: GroupVerificationStats;
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

function buildGroupVerificationTool(): Anthropic.Tool {
  return {
    name: "verify_group",
    description:
      "Verify whether a proposed group of concept names are all truly the exact same concept, splitting into sub-groups if not.",
    input_schema: {
      type: "object",
      properties: {
        groups: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
        },
      },
      required: ["groups"],
    },
  };
}

function buildGroupVerificationPrompt(names: readonly string[]): string {
  return `The following concept names were grouped together as the SAME concept, via a chain of pairwise similarity comparisons. Chained pairwise comparisons can be wrong: "A is the same as B" plus "B is the same as C" doesn't guarantee "A is the same as C" — A and C might never have been compared directly, and might actually be different concepts.

Look at ALL of these names together and decide the correct final grouping: which ones are truly, 100% the exact same concept (a learner missing a card about one would be missing the exact same fact/rule as a learner missing a card about another), and which ones need to be split out as their own separate concept (or a smaller sub-group).

Be strict — when in doubt, split rather than keep grouped.

Names:
${names.map((n) => `- "${n}"`).join("\n")}

Return the final grouping as a list of groups, where each group is a list of the names that belong together. Every input name must appear in EXACTLY ONE output group — a name that doesn't truly match any other becomes its own group of size 1.`;
}

function validateGroupVerification(input: unknown, names: readonly string[]): string[][] {
  if (typeof input !== "object" || input === null || !("groups" in input)) {
    throw new Error("Invalid group verification: missing 'groups'");
  }
  const groups = (input as { groups: unknown }).groups;
  if (!Array.isArray(groups)) throw new Error("Invalid group verification: 'groups' is not an array");

  const seen = new Set<string>();
  for (const group of groups) {
    if (!Array.isArray(group)) throw new Error("Invalid sub-group: not an array");
    for (const name of group) {
      if (typeof name !== "string") throw new Error("Invalid name in sub-group");
      if (!names.includes(name)) throw new Error(`Unknown name in verification result: ${name}`);
      if (seen.has(name)) throw new Error(`Name appears in multiple sub-groups: ${name}`);
      seen.add(name);
    }
  }
  if (seen.size !== names.length) {
    throw new Error(`Verification result missing some names (expected ${names.length}, got ${seen.size})`);
  }

  return groups as string[][];
}

export interface GroupVerificationStats {
  groupsChecked: number;
  verified: number;
  /** Verification failed after retries; the group was conservatively split into singletons. */
  failed: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Re-examines a proposed transitive merge group (size > 2) as a whole,
 * asking the LLM to confirm it or split it into smaller sub-groups — the
 * fix for chained pairwise decisions producing an over-broad group (e.g.
 * 7 unrelated verbs collapsing into one "Pretérito imperfeito" bucket
 * because each was separately, and correctly in isolation, judged close to
 * one shared neighbor). On unrecoverable failure, conservatively splits
 * the group into singletons rather than keeping an unverified merge.
 */
async function verifyGroup(
  names: readonly string[],
  ctx: {
    client: MinimalAnthropicClient;
    model: string;
    maxRetries: number;
    sleep: (ms: number) => Promise<void>;
    onUsage: (usage: { inputTokens: number; outputTokens: number }) => void;
    onAttempt: () => void;
  },
): Promise<{ groups: string[][]; failed: boolean }> {
  for (let attempt = 0; attempt <= ctx.maxRetries; attempt++) {
    ctx.onAttempt();
    try {
      const message = await ctx.client.messages.create({
        model: ctx.model,
        max_tokens: 2048,
        tools: [buildGroupVerificationTool()],
        tool_choice: { type: "tool", name: "verify_group" },
        messages: [{ role: "user", content: buildGroupVerificationPrompt(names) }],
      });
      ctx.onUsage({ inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens });

      const toolUse = message.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );
      if (!toolUse) throw new Error("Model response did not include a tool_use block");

      const groups = validateGroupVerification(toolUse.input, names);
      return { groups, failed: false };
    } catch {
      if (attempt < ctx.maxRetries) await ctx.sleep(1000 * 2 ** attempt);
    }
  }

  return { groups: names.map((n) => [n]), failed: true };
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
      groupVerification: { groupsChecked: 0, verified: 0, failed: 0, calls: 0, inputTokens: 0, outputTokens: 0 },
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

  const transitiveGroups = new Map<number, number[]>();
  for (let i = 0; i < names.length; i++) {
    const root = find(i);
    const group = transitiveGroups.get(root);
    if (group) group.push(i);
    else transitiveGroups.set(root, [i]);
  }

  const model = options.model ?? DEFAULT_MODEL;
  const maxRetriesPerBatch = options.maxRetriesPerBatch ?? 2;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const groupVerification: GroupVerificationStats = {
    groupsChecked: 0,
    verified: 0,
    failed: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  const finalGroups: string[][] = [];
  for (const indices of transitiveGroups.values()) {
    const groupNames = indices.map((i) => names[i]!);

    if (groupNames.length <= 2) {
      finalGroups.push(groupNames);
      continue;
    }

    groupVerification.groupsChecked++;
    const verification = await verifyGroup(groupNames, {
      client: options.client,
      model,
      maxRetries: maxRetriesPerBatch,
      sleep,
      onUsage: (usage) => {
        groupVerification.inputTokens += usage.inputTokens;
        groupVerification.outputTokens += usage.outputTokens;
      },
      onAttempt: () => groupVerification.calls++,
    });

    if (verification.failed) groupVerification.failed++;
    else groupVerification.verified++;
    finalGroups.push(...verification.groups);
  }

  const canonicalNameByOriginal = new Map<string, string>();
  const merges: ConceptMerge[] = [];

  for (const groupNames of finalGroups) {
    const sorted = [...groupNames].sort((a, b) => {
      const freqDiff = (conceptCounts.get(b) ?? 0) - (conceptCounts.get(a) ?? 0);
      return freqDiff !== 0 ? freqDiff : a.localeCompare(b);
    });

    const canonical = sorted[0]!;
    for (const name of sorted) canonicalNameByOriginal.set(name, canonical);

    if (sorted.length > 1) {
      merges.push({ canonical, mergedFrom: sorted.slice(1) });
    }
  }

  return { canonicalNameByOriginal, merges, decisions, stats, groupVerification };
}
