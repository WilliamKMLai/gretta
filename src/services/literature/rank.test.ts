/**
 * Local re-ranking tests (DECISIONS.md ADR-029). Mirrors the cosine cases in
 * `scripts/kb/score.test.mts` deliberately: the duplication of the arithmetic
 * is a recorded decision, so both copies are held to the same behaviour.
 */
import { describe, expect, it } from 'vitest';
import {
  applyRankAdjustments,
  cosineSimilarity,
  embeddableText,
  lexicalOverlap,
  rankByOverlap,
  rankByRelevance,
} from './rank';

describe('cosineSimilarity', () => {
  it('scores identical vectors at 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('scores orthogonal vectors at 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('scores opposed vectors at -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('returns 0 for a zero vector', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('returns 0 on a dimension mismatch rather than guessing', () => {
    // Different embedding models: incomparable, so treated as unrelated.
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('rankByRelevance', () => {
  const passage = [1, 0, 0];

  it('orders candidates by similarity, highest first', () => {
    const ranked = rankByRelevance(passage, [
      { payload: 'unrelated', embedding: [0, 1, 0] },
      { payload: 'exact', embedding: [1, 0, 0] },
      { payload: 'partial', embedding: [1, 1, 0] },
    ]);
    expect(ranked.map((entry) => entry.payload)).toEqual(['exact', 'partial', 'unrelated']);
  });

  it('floors negative similarity at 0 instead of rescaling', () => {
    const ranked = rankByRelevance(passage, [{ payload: 'opposed', embedding: [-1, 0, 0] }]);
    expect(ranked[0]?.relevance).toBe(0);
  });

  it('keeps source order for ties, preserving the source ranking as tie-break', () => {
    const ranked = rankByRelevance(passage, [
      { payload: 'first', embedding: [0, 1, 0] },
      { payload: 'second', embedding: [0, 1, 0] },
      { payload: 'third', embedding: [0, 1, 0] },
    ]);
    expect(ranked.map((entry) => entry.payload)).toEqual(['first', 'second', 'third']);
  });

  it('sinks un-embeddable candidates rather than dropping them', () => {
    // A short embedding must not make a record vanish from the user's view.
    const ranked = rankByRelevance(passage, [
      { payload: 'broken', embedding: [] },
      { payload: 'good', embedding: [1, 0, 0] },
    ]);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.payload).toBe('good');
    expect(ranked[1]?.relevance).toBe(0);
  });

  it('returns an empty list for no candidates', () => {
    expect(rankByRelevance(passage, [])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const candidates = [
      { payload: 'a', embedding: [0, 1, 0] },
      { payload: 'b', embedding: [1, 0, 0] },
    ];
    rankByRelevance(passage, candidates);
    expect(candidates.map((entry) => entry.payload)).toEqual(['a', 'b']);
  });
});

describe('embeddableText', () => {
  it('combines title and abstract', () => {
    expect(embeddableText({ title: 'Base editing', abstract: 'We show that...' })).toBe(
      'Base editing\n\nWe show that...',
    );
  });

  it('falls back to the title alone when there is no abstract', () => {
    expect(embeddableText({ title: 'Base editing', abstract: null })).toBe('Base editing');
    expect(embeddableText({ title: 'Base editing', abstract: '   ' })).toBe('Base editing');
  });

  it('omits the venue, so journal prestige cannot leak into a relevance score', () => {
    const text = embeddableText({ title: 'Base editing', abstract: 'Findings.' });
    expect(text).not.toContain('Nature');
  });
});

describe('lexicalOverlap', () => {
  it('scores full coverage of the passage at 1', () => {
    expect(lexicalOverlap('base editing hepatocytes', 'base editing in hepatocytes works')).toBe(1);
  });

  it('scores no shared content at 0', () => {
    expect(lexicalOverlap('base editing', 'glacier retreat patterns')).toBe(0);
  });

  it('measures against the passage, not the union', () => {
    // A long abstract must not be penalised for covering extra ground.
    const short = lexicalOverlap('base editing', 'base editing');
    const long = lexicalOverlap('base editing', `base editing ${'unrelated '.repeat(50)}`);
    expect(long).toBe(short);
  });

  it('ignores stopwords, so shared grammar is not shared meaning', () => {
    expect(lexicalOverlap('the and of we', 'the and of we')).toBe(0);
  });

  it('cannot see synonymy, which is why it is only a fallback', () => {
    // The documented weakness: "hepatic" and "liver" are the same idea.
    expect(lexicalOverlap('hepatic toxicity', 'liver toxicity')).toBeLessThan(1);
  });

  it('returns 0 for empty input on either side', () => {
    expect(lexicalOverlap('', 'anything')).toBe(0);
    expect(lexicalOverlap('anything', '')).toBe(0);
  });
});

describe('applyRankAdjustments', () => {
  interface Item {
    id: string;
    relevance: number | null;
    impact: number;
  }

  const byImpactField = (entry: Item): number => entry.impact;

  it('lets high impact win a close relevance call', () => {
    const ranked = applyRankAdjustments<Item>(
      [
        { id: 'a', relevance: 0.5, impact: 0 },
        { id: 'b', relevance: 0.45, impact: 1 },
      ],
      {
        impact: byImpactField,
        impactWeight: 0.2,
      },
    );
    expect(ranked.map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('does not let maximum impact override a large relevance gap', () => {
    const ranked = applyRankAdjustments<Item>(
      [
        { id: 'relevant', relevance: 0.9, impact: 0 },
        { id: 'cited', relevance: 0.3, impact: 1 },
      ],
      {
        impact: byImpactField,
        impactWeight: 0.2,
      },
    );
    expect(ranked.map((entry) => entry.id)).toEqual(['relevant', 'cited']);
  });

  it('treats zero impact as neutral, not a penalty, among equally relevant candidates', () => {
    const ranked = applyRankAdjustments<Item>(
      [
        { id: 'first', relevance: 0.5, impact: 0 },
        { id: 'second', relevance: 0.5, impact: 0 },
      ],
      {
        impact: byImpactField,
        impactWeight: 0.2,
      },
    );
    expect(ranked.map((entry) => entry.id)).toEqual(['first', 'second']);
  });

  it('does not mutate the input array', () => {
    const items: Item[] = [
      { id: 'a', relevance: 0.1, impact: 0 },
      { id: 'b', relevance: 0.9, impact: 0 },
    ];
    applyRankAdjustments<Item>(items, { impact: byImpactField, impactWeight: 0.2 });
    expect(items.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('subtracts the penalty at full strength, not scaled by the impact weight', () => {
    // Load-bearing: a demotion for what a record *is* must not weaken as the
    // citation weight is turned down, or setting that weight to 0 would also
    // stop supplementary material being demoted (ADR-029, sixth amendment).
    const ranked = applyRankAdjustments<Item>(
      [
        { id: 'supplementary', relevance: 0.9, impact: 0 },
        { id: 'paper', relevance: 0.6, impact: 0 },
      ],
      {
        impact: byImpactField,
        impactWeight: 0,
        penalty: (entry) => (entry.id === 'supplementary' ? 0.5 : 0),
      },
    );
    expect(ranked.map((entry) => entry.id)).toEqual(['paper', 'supplementary']);
  });

  it('composes boost and penalty in one pass rather than letting the last sort win', () => {
    // If these were applied as two successive sorts, the second would rescore
    // from `relevance` alone and throw the boost away. `boosted` only stays on
    // top if both terms are in the same score.
    const ranked = applyRankAdjustments<Item>(
      [
        { id: 'plain', relevance: 0.5, impact: 0 },
        { id: 'boosted', relevance: 0.45, impact: 1 },
      ],
      {
        impact: byImpactField,
        impactWeight: 0.6,
        penalty: () => 0.2,
      },
    );
    expect(ranked.map((entry) => entry.id)).toEqual(['boosted', 'plain']);
  });

  it('leaves the relevance order alone when neither term is supplied', () => {
    const ranked = applyRankAdjustments<Item>(
      [
        { id: 'high', relevance: 0.9, impact: 1 },
        { id: 'low', relevance: 0.2, impact: 1 },
      ],
      {},
    );
    expect(ranked.map((entry) => entry.id)).toEqual(['high', 'low']);
  });
});

describe('rankByOverlap', () => {
  it('orders by overlap, highest first', () => {
    const ranked = rankByOverlap('base editing hepatocytes', [
      { payload: 'weak', text: 'glacier retreat' },
      { payload: 'strong', text: 'base editing in hepatocytes' },
      { payload: 'partial', text: 'base editing in neurons' },
    ]);
    expect(ranked.map((entry) => entry.payload)).toEqual(['strong', 'partial', 'weak']);
  });

  it('keeps source order for ties and drops nothing', () => {
    const ranked = rankByOverlap('unrelated terms', [
      { payload: 'first', text: 'nothing shared' },
      { payload: 'second', text: 'also nothing' },
    ]);
    expect(ranked.map((entry) => entry.payload)).toEqual(['first', 'second']);
  });

  it('returns an empty list for no candidates', () => {
    expect(rankByOverlap('anything', [])).toEqual([]);
  });
});
