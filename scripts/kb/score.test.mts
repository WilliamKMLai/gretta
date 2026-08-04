import { describe, expect, it } from 'vitest';
import { type Scorable, cosineSimilarity, topK, topKPacked } from './score.mts';

/** L2-normalizes rows into the contiguous layout `topKPacked` expects. */
function packMatrix(vectors: readonly (readonly number[])[]): {
  matrix: Float32Array;
  dims: number;
} {
  const dims = vectors[0]?.length ?? 0;
  const matrix = new Float32Array(vectors.length * dims);
  vectors.forEach((vector, i) => {
    let norm = 0;
    for (const v of vector) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) return;
    const base = i * dims;
    for (let d = 0; d < dims; d += 1) matrix[base + d] = (vector[d] ?? 0) / norm;
  });
  return { matrix, dims };
}

/** Deterministic PRNG (mulberry32) so the equivalence test is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('cosineSimilarity', () => {
  it('is 1 for identical direction and 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('is -1 for opposite direction', () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1);
  });

  it('returns 0 for a zero vector or a length mismatch', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('topK', () => {
  const items: Scorable<string>[] = [
    { payload: 'east', embedding: [1, 0] },
    { payload: 'north', embedding: [0, 1] },
    { payload: 'northeast', embedding: [1, 1] },
  ];

  it('ranks by similarity and respects k', () => {
    const results = topK([1, 0], items, 2);
    expect(results.map((r) => r.payload)).toEqual(['east', 'northeast']);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 1);
  });

  it('floors negative similarities to 0 and applies minScore', () => {
    const withOpposite: Scorable<string>[] = [
      { payload: 'match', embedding: [1, 0] },
      { payload: 'opposite', embedding: [-1, 0] },
    ];
    const results = topK([1, 0], withOpposite, 5, 0.1);
    expect(results.map((r) => r.payload)).toEqual(['match']);
  });

  it('returns [] for k<=0 or empty input and never mutates input', () => {
    const snapshot = JSON.stringify(items);
    expect(topK([1, 0], items, 0)).toEqual([]);
    expect(topK([1, 0], [], 3)).toEqual([]);
    expect(JSON.stringify(items)).toBe(snapshot);
  });

  it('is stable for equal scores (original order preserved)', () => {
    const tied: Scorable<string>[] = [
      { payload: 'first', embedding: [1, 0] },
      { payload: 'second', embedding: [1, 0] },
    ];
    expect(topK([1, 0], tied, 2).map((r) => r.payload)).toEqual(['first', 'second']);
  });
});

describe('topKPacked', () => {
  // Mirrors the `topK` fixture above: east/north/northeast at row 0/1/2.
  const vectors = [
    [1, 0],
    [0, 1],
    [1, 1],
  ];
  const { matrix, dims } = packMatrix(vectors);

  it('ranks by similarity and respects k', () => {
    const results = topKPacked(Float32Array.from([1, 0]), matrix, dims, vectors.length, 2);
    expect(results.map((r) => r.index)).toEqual([0, 2]); // east, northeast
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 1);
  });

  it('floors negative similarities to 0 and applies minScore', () => {
    const { matrix: opposite, dims: oppositeDims } = packMatrix([
      [1, 0],
      [-1, 0],
    ]);
    const results = topKPacked(Float32Array.from([1, 0]), opposite, oppositeDims, 2, 5, 0.1);
    expect(results.map((r) => r.index)).toEqual([0]);
  });

  it('returns [] for k<=0, count<=0, or dims<=0, and never mutates the matrix', () => {
    const snapshot = Float32Array.from(matrix);
    expect(topKPacked(Float32Array.from([1, 0]), matrix, dims, vectors.length, 0)).toEqual([]);
    expect(topKPacked(Float32Array.from([1, 0]), matrix, dims, 0, 3)).toEqual([]);
    expect(topKPacked(Float32Array.from([1, 0]), matrix, 0, vectors.length, 3)).toEqual([]);
    expect(matrix).toEqual(snapshot);
  });

  it('is stable for equal scores (original row order preserved)', () => {
    const { matrix: tied, dims: tiedDims } = packMatrix([
      [1, 0],
      [1, 0],
    ]);
    const results = topKPacked(Float32Array.from([1, 0]), tied, tiedDims, 2, 2);
    expect(results.map((r) => r.index)).toEqual([0, 1]);
  });

  it('caps output at min(k, count) even when every row qualifies', () => {
    const { matrix: many, dims: manyDims } = packMatrix([
      [1, 0],
      [1, 0],
      [1, 0],
    ]);
    const results = topKPacked(Float32Array.from([1, 0]), many, manyDims, 3, 10);
    expect(results).toHaveLength(3);
  });
});

describe('topK vs topKPacked equivalence', () => {
  it('agree on ranking and scores for random inputs', () => {
    const rng = mulberry32(0x5eed);
    const dims = 12;
    const count = 40;
    const vectors = Array.from({ length: count }, () =>
      Array.from({ length: dims }, () => rng() * 2 - 1),
    );
    const query = Array.from({ length: dims }, () => rng() * 2 - 1);
    const k = 8;
    const minScore = 0.05;

    const items: Scorable<number>[] = vectors.map((embedding, index) => ({
      payload: index,
      embedding,
    }));
    const expected = topK(query, items, k, minScore);

    const { matrix, dims: packedDims } = packMatrix(vectors);
    const actual = topKPacked(Float32Array.from(query), matrix, packedDims, count, k, minScore);

    expect(actual.map((match) => match.index)).toEqual(expected.map((entry) => entry.payload));
    actual.forEach((match, i) => {
      expect(match.score).toBeCloseTo(expected[i]?.score ?? -1, 4);
    });
  });
});
