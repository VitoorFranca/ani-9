import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractConcepts } from "../../src/concepts/extract.js";
import type { MinimalAnthropicClient } from "../../src/concepts/extract.js";
import type Anthropic from "@anthropic-ai/sdk";

const noSleep = async () => {};

function toolUseMessage(cards: { card_id: number; concepts: { name: string; weight: number }[] }[]): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [
      {
        type: "tool_use",
        id: "tool_1",
        name: "extract_concepts",
        input: { cards },
        caller: { type: "direct" },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
  } as unknown as Anthropic.Message;
}

describe("extractConcepts", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "ani9-extract-cache-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("extracts concepts for each card and records token usage", async () => {
    const create = vi.fn().mockResolvedValue(
      toolUseMessage([
        { card_id: 1, concepts: [{ name: "carro", weight: 0.9 }] },
        { card_id: 2, concepts: [{ name: "casa", weight: 0.7 }] },
      ]),
    );
    const client: MinimalAnthropicClient = { messages: { create } };

    const { conceptsByCard, stats } = await extractConcepts(
      [
        { cardId: 1, front: "My car is blue", back: "Meu carro é azul" },
        { cardId: 2, front: "My house is big", back: "Minha casa é grande" },
      ],
      { client, cacheDir, sleep: noSleep },
    );

    expect(conceptsByCard.get(1)).toEqual([{ name: "carro", weight: 0.9 }]);
    expect(conceptsByCard.get(2)).toEqual([{ name: "casa", weight: 0.7 }]);
    expect(stats.calls).toBe(1);
    expect(stats.batches).toBe(1);
    expect(stats.cacheHits).toBe(0);
    expect(stats.inputTokens).toBe(100);
    expect(stats.outputTokens).toBe(50);
    expect(stats.failedBatches).toEqual([]);
  });

  it("sends front/back separately, labeled PERGUNTA/RESPOSTA", async () => {
    const create = vi.fn().mockResolvedValue(toolUseMessage([{ card_id: 1, concepts: [{ name: "carro", weight: 0.9 }] }]));
    const client: MinimalAnthropicClient = { messages: { create } };

    await extractConcepts([{ cardId: 1, front: "My car is blue", back: "Meu carro é azul" }], {
      client,
      cacheDir,
      sleep: noSleep,
    });

    const prompt = create.mock.calls[0]![0].messages[0].content as string;
    expect(prompt).toContain("PERGUNTA: My car is blue");
    expect(prompt).toContain("RESPOSTA: Meu carro é azul");
  });

  it("never re-sends a card whose content was already cached", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolUseMessage([{ card_id: 1, concepts: [{ name: "carro", weight: 0.9 }] }]));
    const client: MinimalAnthropicClient = { messages: { create } };

    const cards = [{ cardId: 1, front: "My car is blue", back: "Meu carro é azul" }];
    const first = await extractConcepts(cards, { client, cacheDir, sleep: noSleep });
    expect(first.stats.cacheHits).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);

    const second = await extractConcepts(cards, { client, cacheDir, sleep: noSleep });
    expect(second.stats.cacheHits).toBe(1);
    expect(second.conceptsByCard.get(1)).toEqual([{ name: "carro", weight: 0.9 }]);
    expect(create).toHaveBeenCalledTimes(1); // still just the one call from before
  });

  it("splits cards into multiple batches according to batchSize", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolUseMessage([{ card_id: 1, concepts: [{ name: "a", weight: 1 }] }]))
      .mockResolvedValueOnce(toolUseMessage([{ card_id: 2, concepts: [{ name: "b", weight: 1 }] }]));
    const client: MinimalAnthropicClient = { messages: { create } };

    const { stats } = await extractConcepts(
      [
        { cardId: 1, front: "one", back: "um" },
        { cardId: 2, front: "two", back: "dois" },
      ],
      { client, cacheDir, batchSize: 1, sleep: noSleep },
    );

    expect(stats.batches).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("retries a batch that returns invalid tool input, then succeeds", async () => {
    const badMessage = toolUseMessage([]);
    (badMessage.content[0] as { input: unknown }).input = { not_cards: true };

    const create = vi
      .fn()
      .mockResolvedValueOnce(badMessage)
      .mockResolvedValueOnce(toolUseMessage([{ card_id: 1, concepts: [{ name: "carro", weight: 0.9 }] }]));
    const client: MinimalAnthropicClient = { messages: { create } };

    const { conceptsByCard, stats } = await extractConcepts(
      [{ cardId: 1, front: "My car is blue", back: "Meu carro é azul" }],
      { client, cacheDir, maxRetriesPerBatch: 2, sleep: noSleep },
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(stats.calls).toBe(2);
    expect(conceptsByCard.get(1)).toEqual([{ name: "carro", weight: 0.9 }]);
    expect(stats.failedBatches).toEqual([]);
  });

  it("records a batch as failed after exhausting retries, without throwing", async () => {
    const create = vi.fn().mockRejectedValue(new Error("network error"));
    const client: MinimalAnthropicClient = { messages: { create } };

    const { conceptsByCard, stats } = await extractConcepts(
      [{ cardId: 1, front: "My car is blue", back: "Meu carro é azul" }],
      { client, cacheDir, maxRetriesPerBatch: 1, sleep: noSleep },
    );

    expect(create).toHaveBeenCalledTimes(2); // initial + 1 retry
    expect(stats.failedBatches).toHaveLength(1);
    expect(stats.failedBatches[0]?.cardIds).toEqual([1]);
    expect(conceptsByCard.get(1)).toEqual([]);
  });

  it("feeds concepts already seen in one batch as known concepts to the next batch's prompt", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolUseMessage([{ card_id: 1, concepts: [{ name: "carro", weight: 0.9 }] }]))
      .mockResolvedValueOnce(toolUseMessage([{ card_id: 2, concepts: [{ name: "carro", weight: 0.8 }] }]));
    const client: MinimalAnthropicClient = { messages: { create } };

    await extractConcepts(
      [
        { cardId: 1, front: "one", back: "um" },
        { cardId: 2, front: "two", back: "dois" },
      ],
      { client, cacheDir, batchSize: 1, sleep: noSleep },
    );

    const secondCallPrompt = create.mock.calls[1]![0].messages[0].content as string;
    expect(secondCallPrompt).toContain("carro");
  });

  it("rejects a card with more than 6 concepts as invalid, triggering a retry", async () => {
    const tooMany = toolUseMessage([
      {
        card_id: 1,
        concepts: Array.from({ length: 7 }, (_, i) => ({ name: `conceito-${i}`, weight: 0.5 })),
      },
    ]);
    const create = vi
      .fn()
      .mockResolvedValueOnce(tooMany)
      .mockResolvedValueOnce(toolUseMessage([{ card_id: 1, concepts: [{ name: "ok", weight: 0.5 }] }]));
    const client: MinimalAnthropicClient = { messages: { create } };

    const { conceptsByCard } = await extractConcepts(
      [{ cardId: 1, front: "some card", back: "algum cartão" }],
      { client, cacheDir, sleep: noSleep },
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(conceptsByCard.get(1)).toEqual([{ name: "ok", weight: 0.5 }]);
  });

  it("splits a batch on stop_reason=max_tokens and still extracts both cards", async () => {
    const create = vi.fn().mockImplementation(async (params: { messages: { content: string }[] }) => {
      const prompt = params.messages[0]!.content;
      if (prompt.includes("Cartão 1") && prompt.includes("Cartão 2")) {
        return { ...toolUseMessage([]), stop_reason: "max_tokens" } as Anthropic.Message;
      }
      if (prompt.includes("Cartão 1")) {
        return toolUseMessage([{ card_id: 1, concepts: [{ name: "a", weight: 1 }] }]);
      }
      return toolUseMessage([{ card_id: 2, concepts: [{ name: "b", weight: 1 }] }]);
    });
    const client: MinimalAnthropicClient = { messages: { create } };

    const { conceptsByCard, stats } = await extractConcepts(
      [
        { cardId: 1, front: "one", back: "um" },
        { cardId: 2, front: "two", back: "dois" },
      ],
      { client, cacheDir, sleep: noSleep },
    );

    expect(conceptsByCard.get(1)).toEqual([{ name: "a", weight: 1 }]);
    expect(conceptsByCard.get(2)).toEqual([{ name: "b", weight: 1 }]);
    expect(stats.failedBatches).toEqual([]);
  });
});
