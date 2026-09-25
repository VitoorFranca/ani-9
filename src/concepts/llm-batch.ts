import type Anthropic from "@anthropic-ai/sdk";
import type { MinimalAnthropicClient } from "./anthropic-client.js";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface BatchFailure<Id> {
  ids: Id[];
  error: string;
}

export interface RunLlmBatchOptions<TItem, TResult, Id> {
  client: MinimalAnthropicClient;
  model: string;
  maxOutputTokens: number;
  maxRetries: number;
  sleep: (ms: number) => Promise<void>;
  onUsage: (usage: LlmUsage) => void;
  onAttempt: () => void;
  toolName: string;
  itemId: (item: TItem) => Id;
  buildTool: () => Anthropic.Tool;
  buildPrompt: (items: readonly TItem[]) => string;
  /** Parses+validates the tool input for THIS sub-batch, throwing on any contract violation (triggers a retry). */
  parse: (input: unknown, items: readonly TItem[]) => Map<Id, TResult>;
}

/**
 * Calls the model once per (sub-)batch, with two distinct failure-recovery
 * strategies:
 *  - `stop_reason === "max_tokens"` (the model ran out of room mid-output):
 *    NOT retried as-is — instead the batch is split in half and each half
 *    is processed independently, recursively down to a single item if
 *    needed. A single item that still hits max_tokens is recorded failed.
 *  - any other failure (network, missing tool_use, schema/contract
 *    violation in `parse`): retried with exponential backoff up to
 *    `maxRetries`, re-sending the SAME (sub-)batch unchanged.
 *
 * Splitting on the two parallel halves uses the same `items` (e.g. known
 * concept names) captured by the caller's `buildPrompt` closure for the
 * ORIGINAL batch — a split half's prompt won't see anything learned by its
 * sibling half. That's an accepted simplification: it only affects the rare
 * case of a truncated response, not the normal path.
 */
export async function runLlmBatchWithSplitting<TItem, TResult, Id>(
  items: readonly TItem[],
  opts: RunLlmBatchOptions<TItem, TResult, Id>,
): Promise<{ results: Map<Id, TResult>; failed: BatchFailure<Id>[] }> {
  if (items.length === 0) return { results: new Map(), failed: [] };

  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    opts.onAttempt();
    try {
      const message = await opts.client.messages.create({
        model: opts.model,
        max_tokens: opts.maxOutputTokens,
        tools: [opts.buildTool()],
        tool_choice: { type: "tool", name: opts.toolName },
        messages: [{ role: "user", content: opts.buildPrompt(items) }],
      });
      opts.onUsage({ inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens });

      if (message.stop_reason === "max_tokens") {
        if (items.length === 1) {
          return {
            results: new Map(),
            failed: [
              { ids: [opts.itemId(items[0]!)], error: "Model output exceeded max_tokens even for a single item" },
            ],
          };
        }
        const mid = Math.ceil(items.length / 2);
        const [left, right] = await Promise.all([
          runLlmBatchWithSplitting(items.slice(0, mid), opts),
          runLlmBatchWithSplitting(items.slice(mid), opts),
        ]);
        return {
          results: new Map([...left.results, ...right.results]),
          failed: [...left.failed, ...right.failed],
        };
      }

      const toolUse = message.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );
      if (!toolUse) throw new Error("Model response did not include a tool_use block");

      return { results: opts.parse(toolUse.input, items), failed: [] };
    } catch (error) {
      lastError = error;
      if (attempt < opts.maxRetries) {
        await opts.sleep(1000 * 2 ** attempt);
      }
    }
  }

  return {
    results: new Map(),
    failed: [
      {
        ids: items.map(opts.itemId),
        error: lastError instanceof Error ? lastError.message : String(lastError),
      },
    ],
  };
}
