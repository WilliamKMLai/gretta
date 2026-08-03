/**
 * Pure retrieval scoring for the knowledge-base companion (DECISIONS.md
 * ADR-020). Brute-force cosine ranking over stored chunk embeddings — the
 * default index below the size threshold in ADR-020, above which sqlite-vec
 * ANN takes over behind this same ranking contract. Imports nothing; tested
 * directly in vitest.
 */

/**
 * Cosine similarity of two equal-length vectors, clamped to [-1, 1]. Returns
 * 0 for a zero vector (no direction) or a length mismatch (defensive: a
 * dimension mismatch means the stored vectors predate an embedding-model
 * change and must be treated as non-matching until re-indexed — ADR-020).
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const raw = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return raw > 1 ? 1 : raw < -1 ? -1 : raw;
}

/** An item eligible for ranking: an opaque payload plus its embedding. */
export interface Scorable<T> {
  payload: T;
  embedding: readonly number[];
}

/** A ranked result: the payload plus its similarity to the query, 0..1. */
export interface Scored<T> {
  payload: T;
  score: number;
}

/**
 * Ranks `items` by cosine similarity to `query` and returns the best `k`.
 * Results below `minScore` are dropped (a query unrelated to the corpus
 * should inject nothing rather than the least-bad chunk — ADR-020). Negative
 * similarities are floored to 0 so the threshold reads as a plain 0..1 knob.
 * Stable for equal scores (original order preserved) and never mutates input.
 */
export function topK<T>(
  query: readonly number[],
  items: readonly Scorable<T>[],
  k: number,
  minScore = 0,
): Scored<T>[] {
  if (k <= 0 || items.length === 0) return [];
  const scored = items.map((item, index) => ({
    payload: item.payload,
    score: Math.max(0, cosineSimilarity(query, item.embedding)),
    index,
  }));
  scored.sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score));
  return scored
    .filter((entry) => entry.score >= minScore)
    .slice(0, k)
    .map(({ payload, score }) => ({ payload, score }));
}
