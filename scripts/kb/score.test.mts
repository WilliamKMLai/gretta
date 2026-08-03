import { describe, expect, it } from 'vitest';
import { type Scorable, cosineSimilarity, topK } from './score.mts';

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
