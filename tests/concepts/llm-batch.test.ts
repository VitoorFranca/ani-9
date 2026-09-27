import { describe, expect, it, vi } from "vitest";
import { runLlmBatchWithSplitting } from "../../src/concepts/llm-batch.js";
import type { MinimalAnthropicClient } from "../../src/concepts/anthropic-client.js";
import type Anthropic from "@anthropic-ai/sdk";

const noSleep = async () => {};

function message(overrides: Partial<Anthropic.Message> & { toolInput?: unknown }): Anthropic.Message {
  const { toolInput, ...rest } = overrides;
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: toolInput !== undefined
      ? [{ type: "tool_use", id: "t1", name: "tool", input: toolInput, caller: { type: "direct" } }]
      : [],
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
    ...rest,
  } as unknown as Anthropic.Message;
}

function baseOpts(create: (...args: unknown[]) => Promise<Anthropic.Message>) {
  const client: MinimalAnthropicClient = { messages: { create: create as never } };
  return {
    client,
    model: "claude-haiku-4-5",
    maxOutputTokens: 100,
    maxRetries: 2,
    sleep: noSleep,
    onUsage: vi.fn(),
    onAttempt: vi.fn(),
    toolName: "tool",
    itemId: (n: number) => n,
    buildTool: () => ({ name: "tool", input_schema: { type: "object" as const, properties: {} } }),
    buildPrompt: (items: readonly number[]) => `items: ${items.join(",")}`,
  };
}

describe("runLlmBatchWithSplitting", () => {
  it("returns empty results for an empty item list without calling the client", async () => {
    const create = vi.fn();
    const opts = { ...baseOpts(create), parse: () => new Map() };
    const result = await runLlmBatchWithSplitting([], opts);
    expect(result).toEqual({ results: new Map(), failed: [] });
    expect(create).not.toHaveBeenCalled();
  });

  it("parses a successful response into results", async () => {
    const create = vi.fn().mockResolvedValue(message({ toolInput: { ok: true } }));
    const opts = { ...baseOpts(create), parse: (input: unknown) => new Map([[1, input]]) };
    const { results, failed } = await runLlmBatchWithSplitting([1], opts);
    expect(results.get(1)).toEqual({ ok: true });
    expect(failed).toEqual([]);
  });

  it("retries on a parse/validation failure and succeeds on the next attempt", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(message({ toolInput: { bad: true } }))
      .mockResolvedValueOnce(message({ toolInput: { good: true } }));
    const opts = {
      ...baseOpts(create),
      parse: (input: unknown) => {
        if ((input as { bad?: boolean }).bad) throw new Error("invalid");
        return new Map([[1, input]]);
      },
    };
    const { results, failed } = await runLlmBatchWithSplitting([1], opts);
    expect(create).toHaveBeenCalledTimes(2);
    expect(results.get(1)).toEqual({ good: true });
    expect(failed).toEqual([]);
  });

  it("records a failure after exhausting retries, without throwing", async () => {
    const create = vi.fn().mockRejectedValue(new Error("network down"));
    const opts = { ...baseOpts(create), parse: () => new Map() };
    const { results, failed } = await runLlmBatchWithSplitting([1, 2], opts);
    expect(create).toHaveBeenCalledTimes(3); // initial + 2 retries (maxRetries=2)
    expect(results.size).toBe(0);
    expect(failed).toEqual([{ ids: [1, 2], error: "network down" }]);
  });

  it("splits a batch in half on stop_reason=max_tokens, without spending a retry", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(message({ stop_reason: "max_tokens" }))
      .mockResolvedValueOnce(message({ toolInput: { v: "left" } }))
      .mockResolvedValueOnce(message({ toolInput: { v: "right" } }));
    const opts = {
      ...baseOpts(create),
      itemId: (n: number) => n,
      parse: (input: unknown, items: readonly number[]) =>
        new Map(items.map((i) => [i, (input as { v: string }).v])),
    };
    const { results, failed } = await runLlmBatchWithSplitting([1, 2], opts);
    expect(create).toHaveBeenCalledTimes(3);
    expect(results.get(1)).toBe("left");
    expect(results.get(2)).toBe("right");
    expect(failed).toEqual([]);
  });

  it("recurses splitting down to single items and records a failure only for the item that still truncates", async () => {
    // Keyed by the rendered prompt (not call order): runLlmBatchWithSplitting
    // runs the two halves of a split via Promise.all, so which sub-batch's
    // create() call lands first/second isn't guaranteed — only which prompt
    // it sends is.
    const responseByPrompt: Record<string, Anthropic.Message> = {
      "items: 1,2,3,4": message({ stop_reason: "max_tokens" }),
      "items: 1,2": message({ stop_reason: "max_tokens" }),
      "items: 1": message({ toolInput: { v: "one" } }),
      "items: 2": message({ stop_reason: "max_tokens" }), // still truncates even alone -> recorded failed
      "items: 3,4": message({ toolInput: { v: "rest" } }),
    };
    const create = vi.fn().mockImplementation(async (params: { messages: { content: string }[] }) => {
      const prompt = params.messages[0]!.content;
      const response = responseByPrompt[prompt];
      if (!response) throw new Error(`unexpected prompt: ${prompt}`);
      return response;
    });
    const opts = {
      ...baseOpts(create),
      parse: (input: unknown, items: readonly number[]) =>
        new Map(items.map((i) => [i, (input as { v: string }).v])),
    };
    const { results, failed } = await runLlmBatchWithSplitting([1, 2, 3, 4], opts);
    expect(results.get(1)).toBe("one");
    expect(results.get(3)).toBe("rest");
    expect(results.get(4)).toBe("rest");
    expect(failed).toEqual([{ ids: [2], error: "Model output exceeded max_tokens even for a single item" }]);
  });

  it("throws when there is no tool_use block in the response, then retries", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(message({}))
      .mockResolvedValueOnce(message({ toolInput: { ok: true } }));
    const opts = { ...baseOpts(create), parse: (input: unknown) => new Map([[1, input]]) };
    const { results } = await runLlmBatchWithSplitting([1], opts);
    expect(create).toHaveBeenCalledTimes(2);
    expect(results.get(1)).toEqual({ ok: true });
  });
});
