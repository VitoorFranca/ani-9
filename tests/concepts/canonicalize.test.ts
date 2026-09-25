import { describe, expect, it, vi } from "vitest";
import { canonicalizeConcepts, confirmMergeCandidates, findCandidatePairs } from "../../src/concepts/canonicalize.js";
import type { MinimalAnthropicClient } from "../../src/concepts/anthropic-client.js";
import type { EmbedResult, EmbeddingKind, TextEmbedder } from "../../src/embeddings/embed.js";
import type Anthropic from "@anthropic-ai/sdk";

const noSleep = async () => {};

/** Fixed low-dimensional vectors per name, so cosine similarity is fully controlled in tests. */
function fakeEmbedder(vectorByName: Record<string, number[]>): TextEmbedder {
  return {
    async embed(texts: readonly string[], _kind: EmbeddingKind): Promise<EmbedResult> {
      return { vectors: texts.map((t) => vectorByName[t] ?? [0, 0]), cacheHits: 0 };
    },
  };
}

function mergeMessage(decisions: { index: number; merge: boolean; reason?: string }[]): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "tool_use", id: "t1", name: "confirm_merges", input: { decisions }, caller: { type: "direct" } }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
  } as unknown as Anthropic.Message;
}

/** Accepts every proposed group as-is — used when a test doesn't care about group-verification splitting. */
function acceptAllGroupsMessage(groups: string[][]): Anthropic.Message {
  return {
    id: "msg_2",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "tool_use", id: "t2", name: "verify_group", input: { groups }, caller: { type: "direct" } }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
  } as unknown as Anthropic.Message;
}

describe("findCandidatePairs", () => {
  it("pairs up the two identical concepts as each other's top neighbor, deduplicated", async () => {
    // a and b are identical (sim=1); c is orthogonal to both, but with k=1
    // c still gets *some* nearest neighbor pair proposed (its best available
    // match) — the LLM confirmation step is what's expected to reject it.
    const embedder = fakeEmbedder({ a: [1, 0], b: [1, 0], c: [0, 1] });
    const pairs = await findCandidatePairs(["a", "b", "c"], embedder, 1);
    const abPair = pairs.find((p) => p.a === "a" && p.b === "b");
    expect(abPair?.similarity).toBeCloseTo(1);
    // (a,b) appears only once despite both a and b nominating each other.
    expect(pairs.filter((p) => (p.a === "a" && p.b === "b") || (p.a === "b" && p.b === "a"))).toHaveLength(1);
  });

  it("returns an empty list for fewer than 2 names", async () => {
    expect(await findCandidatePairs([], fakeEmbedder({}), 3)).toEqual([]);
    expect(await findCandidatePairs(["only"], fakeEmbedder({ only: [1, 0] }), 3)).toEqual([]);
  });

  it("sorts pairs by descending similarity", async () => {
    const embedder = fakeEmbedder({ a: [1, 0], b: [0.9, Math.sqrt(1 - 0.81)], c: [0, 1] });
    const pairs = await findCandidatePairs(["a", "b", "c"], embedder, 2);
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1]!.similarity).toBeGreaterThanOrEqual(pairs[i]!.similarity);
    }
  });
});

describe("confirmMergeCandidates", () => {
  it("maps decisions back to their original pairs by index", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        mergeMessage([
          { index: 0, merge: true, reason: "same rule" },
          { index: 1, merge: false, reason: "different vocabulary" },
        ]),
      );
    const client: MinimalAnthropicClient = { messages: { create } };

    const pairs = [
      { a: "carro", b: "veículo", similarity: 0.95 },
      { a: "dog", b: "puppy", similarity: 0.92 },
    ];
    const { decisions } = await confirmMergeCandidates(pairs, { client, sleep: noSleep });

    expect(decisions.find((d) => d.a === "carro")).toMatchObject({ merge: true, reason: "same rule" });
    expect(decisions.find((d) => d.a === "dog")).toMatchObject({ merge: false, reason: "different vocabulary" });
  });

  it("batches candidate pairs according to batchSize", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(mergeMessage([{ index: 0, merge: true }]))
      .mockResolvedValueOnce(mergeMessage([{ index: 0, merge: false }]));
    const client: MinimalAnthropicClient = { messages: { create } };

    const pairs = [
      { a: "a1", b: "a2", similarity: 0.9 },
      { a: "b1", b: "b2", similarity: 0.9 },
    ];
    const { stats } = await confirmMergeCandidates(pairs, { client, batchSize: 1, sleep: noSleep });
    expect(stats.batches).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

/** Decides merge=true only for a pair whose prompt line mentions both `a` and `b`; the rest merge=false. */
function mockMergeOnly(a: string, b: string) {
  return vi.fn().mockImplementation(async (params: { messages: { content: string }[] }) => {
    const lines = params.messages[0]!.content.split("\n").filter((l) => /^\d+\./.test(l));
    return mergeMessage(
      lines.map((line, index) => ({ index, merge: line.includes(`"${a}"`) && line.includes(`"${b}"`) })),
    );
  });
}

describe("canonicalizeConcepts", () => {
  it("only merges pairs the LLM confirms, ignoring rejected candidates", async () => {
    const embedder = fakeEmbedder({ carro: [1, 0], automóvel: [0.99, 0.01], casa: [0, 1] });
    const create = mockMergeOnly("carro", "automóvel");
    const client: MinimalAnthropicClient = { messages: { create } };

    const counts = new Map([
      ["carro", 5],
      ["automóvel", 2],
      ["casa", 3],
    ]);
    const { canonicalNameByOriginal, merges, decisions } = await canonicalizeConcepts(counts, {
      embedder,
      client,
      neighborCount: 1,
      sleep: noSleep,
    });

    expect(canonicalNameByOriginal.get("automóvel")).toBe("carro");
    expect(canonicalNameByOriginal.get("carro")).toBe("carro");
    expect(canonicalNameByOriginal.get("casa")).toBe("casa");
    expect(merges).toEqual([{ canonical: "carro", mergedFrom: ["automóvel"] }]);
    // casa also gets a candidate pair proposed (its best available match),
    // which the mock correctly rejects.
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions.every((d) => d.merge === (d.a === "carro" && d.b === "automóvel"))).toBe(true);
  });

  it("never merges a pair the LLM rejects, even with high embedding similarity", async () => {
    const embedder = fakeEmbedder({ my: [1, 0], your: [0.99, 0.01] });
    const create = vi.fn().mockResolvedValue(mergeMessage([{ index: 0, merge: false, reason: "opposites" }]));
    const client: MinimalAnthropicClient = { messages: { create } };

    const counts = new Map([
      ["my", 4],
      ["your", 4],
    ]);
    const { canonicalNameByOriginal, merges } = await canonicalizeConcepts(counts, {
      embedder,
      client,
      neighborCount: 1,
      sleep: noSleep,
    });

    expect(canonicalNameByOriginal.get("my")).toBe("my");
    expect(canonicalNameByOriginal.get("your")).toBe("your");
    expect(merges).toEqual([]);
  });

  it("handles transitive merges across three concepts via union-find, confirmed by group verification", async () => {
    const embedder = fakeEmbedder({ a: [1, 0, 0], b: [0.99, 0.01, 0], c: [0.98, 0.02, 0] });
    // All three are mutually close, so a<->b, a<->c and b<->c all end up as
    // candidates with k=2; confirming all of them as merges collapses them
    // into one transitive group (size 3), which then goes through group
    // verification (size > 2) — the mock accepts the group as-is.
    const create = vi.fn().mockImplementation(async (params: { tools: { name: string }[]; messages: { content: string }[] }) => {
      if (params.tools[0]?.name === "verify_group") {
        return acceptAllGroupsMessage([["a", "b", "c"]]);
      }
      const lines = params.messages[0]!.content.split("\n").filter((l) => /^\d+\./.test(l));
      return mergeMessage(lines.map((_, index) => ({ index, merge: true })));
    });
    const client: MinimalAnthropicClient = { messages: { create } };

    const counts = new Map([
      ["a", 1],
      ["b", 5],
      ["c", 1],
    ]);
    const { canonicalNameByOriginal } = await canonicalizeConcepts(counts, {
      embedder,
      client,
      neighborCount: 2,
      sleep: noSleep,
    });

    const canonical = canonicalNameByOriginal.get("b");
    expect(canonicalNameByOriginal.get("a")).toBe(canonical);
    expect(canonicalNameByOriginal.get("c")).toBe(canonical);
  });

  it("splits an over-broad transitive group via group verification, undoing a chained bad merge", async () => {
    // a<->b and b<->c both get individually (and wrongly, in isolation)
    // confirmed as merges, chaining a and c together via union-find even
    // though they're not the same concept. Group verification, seeing all
    // three together, should split c back out.
    const embedder = fakeEmbedder({ a: [1, 0, 0], b: [0.99, 0.01, 0], c: [0.98, 0.02, 0] });
    const create = vi.fn().mockImplementation(async (params: { tools: { name: string }[]; messages: { content: string }[] }) => {
      if (params.tools[0]?.name === "verify_group") {
        return acceptAllGroupsMessage([["a", "b"], ["c"]]);
      }
      const lines = params.messages[0]!.content.split("\n").filter((l) => /^\d+\./.test(l));
      return mergeMessage(lines.map((_, index) => ({ index, merge: true })));
    });
    const client: MinimalAnthropicClient = { messages: { create } };

    const counts = new Map([
      ["a", 1],
      ["b", 5],
      ["c", 1],
    ]);
    const { canonicalNameByOriginal, merges, groupVerification } = await canonicalizeConcepts(counts, {
      embedder,
      client,
      neighborCount: 2,
      sleep: noSleep,
    });

    expect(canonicalNameByOriginal.get("a")).toBe("b");
    expect(canonicalNameByOriginal.get("c")).toBe("c"); // split back out, not merged with a/b
    expect(merges).toEqual([{ canonical: "b", mergedFrom: ["a"] }]);
    expect(groupVerification.groupsChecked).toBe(1);
    expect(groupVerification.verified).toBe(1);
    expect(groupVerification.failed).toBe(0);
  });

  it("falls back to splitting a group into singletons when verification fails after retries", async () => {
    const embedder = fakeEmbedder({ a: [1, 0, 0], b: [0.99, 0.01, 0], c: [0.98, 0.02, 0] });
    const create = vi.fn().mockImplementation(async (params: { tools: { name: string }[]; messages: { content: string }[] }) => {
      if (params.tools[0]?.name === "verify_group") throw new Error("network error");
      const lines = params.messages[0]!.content.split("\n").filter((l) => /^\d+\./.test(l));
      return mergeMessage(lines.map((_, index) => ({ index, merge: true })));
    });
    const client: MinimalAnthropicClient = { messages: { create } };

    const counts = new Map([
      ["a", 1],
      ["b", 1],
      ["c", 1],
    ]);
    const { canonicalNameByOriginal, merges, groupVerification } = await canonicalizeConcepts(counts, {
      embedder,
      client,
      neighborCount: 2,
      maxRetriesPerBatch: 1,
      sleep: noSleep,
    });

    expect(canonicalNameByOriginal.get("a")).toBe("a");
    expect(canonicalNameByOriginal.get("b")).toBe("b");
    expect(canonicalNameByOriginal.get("c")).toBe("c");
    expect(merges).toEqual([]);
    expect(groupVerification.failed).toBe(1);
  });

  it("returns empty results for no concepts, without calling the LLM", async () => {
    const create = vi.fn();
    const client: MinimalAnthropicClient = { messages: { create } };
    const result = await canonicalizeConcepts(new Map(), { embedder: fakeEmbedder({}), client, sleep: noSleep });
    expect(result.canonicalNameByOriginal.size).toBe(0);
    expect(result.merges).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
});
