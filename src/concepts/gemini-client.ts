export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

export interface GeminiUsage {
  inputTokens: number;
  /** candidatesTokenCount + thoughtsTokenCount — both billed at the same output rate. */
  outputTokens: number;
}

export interface GeminiGenerateContentResult {
  text: string | undefined;
  usage: GeminiUsage;
}

/**
 * Only the shape this module actually needs from a `GoogleGenAI` client —
 * a real instance satisfies this structurally, but tests can pass a
 * lightweight mock instead of hitting the network/spending money.
 */
export interface MinimalGeminiClient {
  models: {
    generateContent(params: {
      model: string;
      contents: string;
      config: {
        responseMimeType: string;
        responseJsonSchema: unknown;
        thinkingConfig?: { thinkingLevel: string };
      };
    }): Promise<{
      text: string | undefined;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
      };
    }>;
  };
}

/** Calls generateContent with minimal thinking and JSON-schema-constrained output, normalizing usage into a flat {inputTokens, outputTokens}. */
export async function generateJson(
  client: MinimalGeminiClient,
  model: string,
  prompt: string,
  jsonSchema: unknown,
): Promise<GeminiGenerateContentResult> {
  const response = await client.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: jsonSchema,
      thinkingConfig: { thinkingLevel: "MINIMAL" },
    },
  });

  const usage = response.usageMetadata;
  return {
    text: response.text,
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    },
  };
}
