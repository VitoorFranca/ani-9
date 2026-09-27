import type Anthropic from "@anthropic-ai/sdk";

/**
 * Only the shape this module actually needs from an Anthropic client — a
 * real `Anthropic` instance satisfies this structurally, but tests can pass
 * a lightweight mock instead of hitting the network/spending money.
 */
export interface MinimalAnthropicClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      tools: Anthropic.Tool[];
      tool_choice: Anthropic.ToolChoiceTool;
      messages: { role: "user"; content: string }[];
    }): Promise<Anthropic.Message>;
  };
}
