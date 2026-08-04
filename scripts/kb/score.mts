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

/** One `topKPacked` match: `index` is a row position into the source matrix. */
export interface PackedMatch {
  index: number;
  score: number;
}

/**
 * `topK`'s ranking contract over a packed, pre-normalized matrix instead of
 * boxed `Scorable<T>[]` — the fast path a large collection needs (ADR-020
 * amendment). `matrix` is `count` rows of `dims` L2-normalized float32s laid
 * out contiguously (row `i` starts at `i * dims`); `query` is raw (not yet
 * normalized — this function normalizes it once, up front). With both sides
 * unit-length, cosine similarity is a bare dot product, so the per-row loop
 * is one multiply-accumulate and no `Math.sqrt`.
 *
 * Selection is bounded insertion into two fixed-size arrays sized `min(k,
 * count)`, kept sorted descending — no full sort of `count` elements, no
 * per-row allocation. A row that cannot beat the current k-th score (once
 * the arrays are full) is rejected before insertion. Ties keep row-scan
 * order (ascending `index`), matching `topK`'s stable sort. `minScore` is
 * applied per-row before insertion, so a below-threshold row never occupies
 * a slot a qualifying later row would need — equivalent to `topK`'s
 * filter-after-sort, proven by the fact both operate on the same
 * score-descending prefix. Negative similarities floor to 0, as in `topK`.
 */
export function topKPacked(
  query: Float32Array,
  matrix: Float32Array,
  dims: number,
  count: number,
  k: number,
  minScore = 0,
): PackedMatch[] {
  if (k <= 0 || count <= 0 || dims <= 0) return [];

  let queryNorm = 0;
  for (let d = 0; d < dims; d += 1) queryNorm += (query[d] ?? 0) * (query[d] ?? 0);
  queryNorm = Math.sqrt(queryNorm);
  const q = new Float32Array(dims);
  if (queryNorm > 0) {
    for (let d = 0; d < dims; d += 1) q[d] = (query[d] ?? 0) / queryNorm;
  }

  const bound = Math.min(k, count);
  const scores = new Float64Array(bound);
  const indices = new Int32Array(bound).fill(-1);
  let filled = 0;
  let floor = -Infinity;

  for (let row = 0; row < count; row += 1) {
    const base = row * dims;
    let dot = 0;
    for (let d = 0; d < dims; d += 1) dot += (matrix[base + d] ?? 0) * (q[d] ?? 0);
    const clamped = dot > 1 ? 1 : dot < -1 ? -1 : dot;
    const score = clamped > 0 ? clamped : 0;
    if (score < minScore) continue;
    if (filled === bound && score <= floor) continue;

    let pos = filled < bound ? filled : bound - 1;
    while (pos > 0 && (scores[pos - 1] ?? -Infinity) < score) {
      scores[pos] = scores[pos - 1] ?? -Infinity;
      indices[pos] = indices[pos - 1] ?? -1;
      pos -= 1;
    }
    scores[pos] = score;
    indices[pos] = row;
    if (filled < bound) filled += 1;
    if (filled === bound) floor = scores[bound - 1] ?? -Infinity;
  }

  const out: PackedMatch[] = [];
  for (let i = 0; i < filled; i += 1) {
    out.push({ index: indices[i] ?? -1, score: scores[i] ?? -Infinity });
  }
  return out;
}
