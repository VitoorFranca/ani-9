import { describe, expect, it, vi } from "vitest";
import { classifyCards } from "../../src/concepts/classify.js";
import type { MinimalGeminiClient } from "../../src/concepts/gemini-client.js";

const noSleep = async () => {};
const FIXED_LIST = ["past simple", "phrasal verb: called off", "future simple"];

function mockClient(generateContent: ReturnType<typeof vi.fn>): MinimalGeminiClient {
  return { models: { generateContent: generateContent as unknown as MinimalGeminiClient["models"]["generateContent"] } };
}

function response(body: unknown, usage = { promptTokenCount: 50, candidatesTokenCount: 20 }) {
  return { text: JSON.stringify(body), usageMetadata: usage };
}

describe("classifyCards", () => {
  it("resolves concept indices into names per card", async () => {
    const generateContent = vi.fn().mockResolvedValue(
      response({
        cards: [
          { card_id: 1, concept_indices: [0, 1] },
          { card_id: 2, concept_indices: [] },
        ],
      }),
    );
    const client = mockClient(generateContent);

    const { conceptsByCard, stats } = await classifyCards(
      [
        { cardId: 1, front: "She called off the wedding.", back: "Ela cancelou o casamento." },
        { cardId: 2, front: "hair", back: "cabelo" },
      ],
      { client, fixedList: FIXED_LIST, sleep: noSleep },
    );

    expect(conceptsByCard.get(1)).toEqual(["past simple", "phrasal verb: called off"]);
    expect(conceptsByCard.get(2)).toEqual([]);
    expect(stats.calls).toBe(1);
    expect(stats.failedBatches).toEqual([]);
    expect(stats.inputTokens).toBe(50);
    expect(stats.outputTokens).toBe(20);
  });

  it("allows a card to have no applicable concepts", async () => {
    const generateContent = vi.fn().mockResolvedValue(response({ cards: [{ card_id: 1, concept_indices: [] }] }));
    const client = mockClient(generateContent);

    const { conceptsByCard } = await classifyCards([{ cardId: 1, front: "x", back: "y" }], {
      client,
      fixedList: FIXED_LIST,
      sleep: noSleep,
    });
    expect(conceptsByCard.get(1)).toEqual([]);
  });

  it("rejects an out-of-range concept index and retries", async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValueOnce(response({ cards: [{ card_id: 1, concept_indices: [99] }] }))
      .mockResolvedValueOnce(response({ cards: [{ card_id: 1, concept_indices: [0] }] }));
    const client = mockClient(generateContent);

    const { conceptsByCard } = await classifyCards([{ cardId: 1, front: "x", back: "y" }], {
      client,
      fixedList: FIXED_LIST,
      maxRetriesPerBatch: 2,
      sleep: noSleep,
    });

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(conceptsByCard.get(1)).toEqual(["past simple"]);
  });

  it("splits cards into batches according to batchSize", async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValueOnce(response({ cards: [{ card_id: 1, concept_indices: [0] }] }))
      .mockResolvedValueOnce(response({ cards: [{ card_id: 2, concept_indices: [1] }] }));
    const client = mockClient(generateContent);

    const { stats } = await classifyCards(
      [
        { cardId: 1, front: "a", back: "b" },
        { cardId: 2, front: "c", back: "d" },
      ],
      { client, fixedList: FIXED_LIST, batchSize: 1, sleep: noSleep },
    );
    expect(stats.batches).toBe(2);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("records a batch as failed after exhausting retries, defaulting those cards to no concepts", async () => {
    const generateContent = vi.fn().mockRejectedValue(new Error("network error"));
    const client = mockClient(generateContent);

    const { conceptsByCard, stats } = await classifyCards([{ cardId: 1, front: "x", back: "y" }], {
      client,
      fixedList: FIXED_LIST,
      maxRetriesPerBatch: 1,
      sleep: noSleep,
    });

    expect(generateContent).toHaveBeenCalledTimes(2); // initial + 1 retry
    expect(stats.failedBatches).toHaveLength(1);
    expect(conceptsByCard.get(1)).toEqual([]);
  });

  it("defaults a card missing from the response to no concepts", async () => {
    const generateContent = vi.fn().mockResolvedValue(response({ cards: [] }));
    const client = mockClient(generateContent);

    const { conceptsByCard } = await classifyCards([{ cardId: 1, front: "x", back: "y" }], {
      client,
      fixedList: FIXED_LIST,
      sleep: noSleep,
    });
    expect(conceptsByCard.get(1)).toEqual([]);
  });
});
