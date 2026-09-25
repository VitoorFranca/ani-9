import { cosineSimilarity, type TextEmbedder } from "../embeddings/embed.js";

export interface ConceptMerge {
  canonical: string;
  mergedFrom: string[];
}

export interface CanonicalizationResult {
  /** Maps every original concept name (including canonical ones) to its canonical form. */
  canonicalNameByOriginal: Map<string, string>;
  /** Audit trail of what got merged into what, for the report. */
  merges: ConceptMerge[];
}

/**
 * Merges concept names whose embeddings are cosine-similar above `threshold`,
 * via union-find. The canonical name of each group is its most frequent
 * member (ties broken alphabetically for determinism).
 *
 * O(n^2) pairwise comparisons: fine for the hundreds of unique concepts a
 * Phase 1 deck produces, but would need blocking/ANN for decks with
 * thousands of unique concepts.
 */
export async function canonicalizeConcepts(
  conceptCounts: ReadonlyMap<string, number>,
  embedder: TextEmbedder,
  threshold = 0.88,
): Promise<CanonicalizationResult> {
  const names = [...conceptCounts.keys()];
  if (names.length === 0) {
    return { canonicalNameByOriginal: new Map(), merges: [] };
  }

  const { vectors } = await embedder.embed(names, "query");

  const parent = names.map((_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (cosineSimilarity(vectors[i]!, vectors[j]!) >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < names.length; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(i);
    else groups.set(root, [i]);
  }

  const canonicalNameByOriginal = new Map<string, string>();
  const merges: ConceptMerge[] = [];

  for (const indices of groups.values()) {
    const groupNames = indices.map((i) => names[i]!);
    groupNames.sort((a, b) => {
      const freqDiff = (conceptCounts.get(b) ?? 0) - (conceptCounts.get(a) ?? 0);
      return freqDiff !== 0 ? freqDiff : a.localeCompare(b);
    });

    const canonical = groupNames[0]!;
    for (const name of groupNames) canonicalNameByOriginal.set(name, canonical);

    if (groupNames.length > 1) {
      merges.push({ canonical, mergedFrom: groupNames.slice(1) });
    }
  }

  return { canonicalNameByOriginal, merges };
}
