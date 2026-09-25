export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export interface Bm25Options {
  k1?: number;
  b?: number;
}

export interface Bm25Index {
  /** Score `queryTokens` against document `docIndex` in the original corpus order. */
  scoreAgainst(queryTokens: readonly string[], docIndex: number): number;
  documentCount: number;
}

/**
 * Builds a BM25 index over a corpus of documents (one string per document,
 * tokenized internally). Standard Robertson/Sparck-Jones BM25 with the
 * "+1" smoothed IDF variant, so common terms never get a negative weight.
 */
export function buildBm25Index(documents: readonly string[], options: Bm25Options = {}): Bm25Index {
  const k1 = options.k1 ?? 1.5;
  const b = options.b ?? 0.75;

  const tokenized = documents.map(tokenize);
  const docLengths = tokenized.map((t) => t.length);
  const avgDocLength = docLengths.length > 0 ? docLengths.reduce((s, l) => s + l, 0) / docLengths.length : 0;

  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const term of new Set(tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const n = documents.length;

  function idf(term: string): number {
    const df = documentFrequency.get(term) ?? 0;
    return Math.log((n - df + 0.5) / (df + 0.5) + 1);
  }

  const termFrequencies = tokenized.map((tokens) => {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return tf;
  });

  function scoreAgainst(queryTokens: readonly string[], docIndex: number): number {
    const tf = termFrequencies[docIndex]!;
    const docLength = docLengths[docIndex]!;
    let score = 0;
    for (const term of queryTokens) {
      const freq = tf.get(term) ?? 0;
      if (freq === 0) continue;
      const numerator = freq * (k1 + 1);
      const denominator = freq + k1 * (1 - b + (avgDocLength > 0 ? (b * docLength) / avgDocLength : 0));
      score += idf(term) * (numerator / denominator);
    }
    return score;
  }

  return { scoreAgainst, documentCount: n };
}
