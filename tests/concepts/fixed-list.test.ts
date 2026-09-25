import { describe, expect, it, vi } from "vitest";
import { generateFixedList, selectFixedListSample } from "../../src/concepts/fixed-list.js";
import type { MinimalGeminiClient } from "../../src/concepts/gemini-client.js";

function mockClient(text: string, usage = { promptTokenCount: 100, candidatesTokenCount: 50 }): MinimalGeminiClient {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue({ text, usageMetadata: usage }),
    },
  };
}

describe("selectFixedListSample", () => {
  it("prioritizes multi-word (phrase) cards over single-word cards", () => {
    const cards = [
      { cardId: 1, front: "hair", back: "" },
      { cardId: 2, front: "She called off the wedding.", back: "" },
      { cardId: 3, front: "temple", back: "" },
      { cardId: 4, front: "I will have you know.", back: "" },
    ];
    const sample = selectFixedListSample(cards, 2);
    expect(sample.map((c) => c.cardId).sort()).toEqual([2, 4]);
  });

  it("fills remaining slots with single-word cards when there aren't enough phrases", () => {
    const cards = [
      { cardId: 1, front: "hair", back: "" },
      { cardId: 2, front: "temple", back: "" },
      { cardId: 3, front: "She called off the wedding.", back: "" },
    ];
    const sample = selectFixedListSample(cards, 3);
    expect(sample).toHaveLength(3);
  });

  it("is deterministic for a fixed seed", () => {
    const cards = Array.from({ length: 20 }, (_, i) => ({
      cardId: i,
      front: i % 2 === 0 ? `phrase number ${i} here` : `word${i}`,
      back: "",
    }));
    const a = selectFixedListSample(cards, 5, 7);
    const b = selectFixedListSample(cards, 5, 7);
    expect(a.map((c) => c.cardId)).toEqual(b.map((c) => c.cardId));
  });

  it("never returns more than sampleSize cards", () => {
    const cards = Array.from({ length: 5 }, (_, i) => ({ cardId: i, front: "one two three", back: "" }));
    expect(selectFixedListSample(cards, 50)).toHaveLength(5);
  });
});

describe("generateFixedList", () => {
  const sample = [
    { cardId: 1, front: "She called off the wedding.", back: "Ela cancelou o casamento." },
    { cardId: 2, front: "He called off the trip.", back: "Ele cancelou a viagem." },
  ];

  it("parses a valid response into concepts with usage", async () => {
    const client = mockClient(
      JSON.stringify({
        concepts: [
          { name: "past simple", description: "Passado simples em inglês.", examples: [1, 2] },
          { name: "phrasal verb: called off", description: "Expressão que significa cancelar.", examples: [1, 2] },
        ],
      }),
    );

    const result = await generateFixedList(sample, { client });

    expect(result.concepts).toEqual([
      { name: "past simple", description: "Passado simples em inglês.", examples: [1, 2] },
      { name: "phrasal verb: called off", description: "Expressão que significa cancelar.", examples: [1, 2] },
    ]);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("throws when the response is missing 'concepts'", async () => {
    const client = mockClient(JSON.stringify({ foo: "bar" }));
    await expect(generateFixedList(sample, { client })).rejects.toThrow(/missing 'concepts'/);
  });

  it("throws when the response text is empty", async () => {
    const client = mockClient(undefined as unknown as string);
    (client.models.generateContent as ReturnType<typeof vi.fn>).mockResolvedValue({ text: undefined, usageMetadata: {} });
    await expect(generateFixedList(sample, { client })).rejects.toThrow(/Empty response/);
  });

  it("throws when a concept cites fewer than 2 examples", async () => {
    const client = mockClient(
      JSON.stringify({ concepts: [{ name: "past simple", description: "...", examples: [1] }] }),
    );
    await expect(generateFixedList(sample, { client })).rejects.toThrow(/at least 2 example card ids/);
  });

  it("throws when a concept cites an example card id outside the sample", async () => {
    const client = mockClient(
      JSON.stringify({ concepts: [{ name: "past simple", description: "...", examples: [1, 999] }] }),
    );
    await expect(generateFixedList(sample, { client })).rejects.toThrow(/not in the sample/);
  });
});
