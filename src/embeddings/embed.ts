import { env, pipeline } from "@huggingface/transformers";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { EmbeddingCache } from "./cache.js";

export const DEFAULT_EMBEDDING_MODEL = "Xenova/multilingual-e5-small";

/**
 * The e5 model family requires a "query: " / "passage: " prefix on every
 * input — documented on the upstream intfloat/multilingual-e5-small model
 * card, not an assumption — or retrieval/similarity quality degrades.
 * "query" is used for both sides of a symmetric comparison (e.g. concept
 * name vs. concept name); "passage" is used for indexed content (cards).
 */
export type EmbeddingKind = "query" | "passage";

export interface EmbedderOptions {
  model?: string;
  /** Directory for the embedding vector cache. */
  cacheDir?: string;
  /** Directory transformers.js should cache downloaded ONNX model weights in. */
  modelCacheDir?: string;
}

export interface EmbedResult {
  vectors: number[][];
  cacheHits: number;
}

export class Embedder {
  private readonly model: string;
  private readonly cache: EmbeddingCache;
  private readonly modelCacheDir: string | undefined;
  private extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(options: EmbedderOptions = {}) {
    this.model = options.model ?? DEFAULT_EMBEDDING_MODEL;
    this.cache = new EmbeddingCache(options.cacheDir ?? "./cache/embeddings");
    this.modelCacheDir = options.modelCacheDir;
  }

  private async getExtractor(): Promise<FeatureExtractionPipeline> {
    if (!this.extractorPromise) {
      if (this.modelCacheDir) env.cacheDir = this.modelCacheDir;
      this.extractorPromise = pipeline("feature-extraction", this.model);
    }
    return this.extractorPromise;
  }

  /**
   * Embeds texts, checking the disk cache first and only running the model
   * for cache misses. Running the same texts twice never recomputes.
   */
  async embed(texts: readonly string[], kind: EmbeddingKind): Promise<EmbedResult> {
    const prefixed = texts.map((text) => `${kind}: ${text}`);
    const cached = await Promise.all(prefixed.map((text) => this.cache.get(this.model, text)));

    const vectors: (number[] | null)[] = [...cached];
    const missIndices = vectors.reduce<number[]>((acc, v, i) => {
      if (v === null) acc.push(i);
      return acc;
    }, []);

    if (missIndices.length > 0) {
      const extractor = await this.getExtractor();
      const missTexts = missIndices.map((i) => prefixed[i]!);
      const output = await extractor(missTexts, { pooling: "mean", normalize: true });
      const computed = output.tolist() as number[][];

      for (let k = 0; k < missIndices.length; k++) {
        const index = missIndices[k]!;
        const vector = computed[k]!;
        vectors[index] = vector;
        await this.cache.set(this.model, prefixed[index]!, vector);
      }
    }

    return { vectors: vectors as number[][], cacheHits: texts.length - missIndices.length };
  }
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
