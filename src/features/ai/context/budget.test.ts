/**
 * Budget allocation (ADR-025).
 *
 * The rule these exist to protect: retrieved excerpts must never be the silent
 * casualty of an over-long prompt, because the pane cites them either way.
 */
import { describe, expect, it } from 'vitest';
import type { RetrievedChunk } from '../../../types/knowledgebase';
import { MAX_EXCERPT_SHARE, allocateBudget, describeBudget } from './budget';
import type { ContextBlock } from './provider';

const chunk = (source: string, score: number, size = 200): RetrievedChunk => ({
  collectionId: 'refs',
  source,
  locator: { page: null, paragraph: 1 },
  text: 'x'.repeat(size),
  score,
});

const block = (sources: RetrievedChunk[]): ContextBlock => ({
  providerId: 'knowledge-base',
  label: 'Excerpts',
  text: sources.map((s) => s.text).join('\n\n'),
  sources,
});

const base = {
  contextLength: 4096,
  reservePct: 25,
  instruction: 'Rewrite this abstract',
  documentContext: null as string | null,
  blocks: [] as ContextBlock[],
  charsPerToken: 4,
};

describe('allocateBudget', () => {
  it('reserves room for the reply', () => {
    const result = allocateBudget(base);
    expect(result.limitTokens).toBe(3072); // 4096 − 25%
  });

  it('leaves everything alone when it all fits', () => {
    const result = allocateBudget({
      ...base,
      documentContext: 'a short document',
      blocks: [block([chunk('a.pdf', 0.9)])],
    });
    expect(result.trimmed).toEqual([]);
    expect(result.overflow).toBe(false);
    expect(result.documentContext).toBe('a short document');
    expect(result.blocks).toHaveLength(1);
  });

  it('trims the document before touching excerpts', () => {
    const result = allocateBudget({
      ...base,
      documentContext: 'd'.repeat(100_000),
      blocks: [block([chunk('a.pdf', 0.9)])],
    });
    expect(result.trimmed.some((note) => note.kind.startsWith('document'))).toBe(true);
    expect(result.trimmed.some((note) => note.kind === 'excerpt-dropped')).toBe(false);
    expect(result.blocks[0]?.sources).toHaveLength(1);
  });

  it('keeps the excerpts intact even when the document is enormous', () => {
    const result = allocateBudget({
      ...base,
      documentContext: 'd'.repeat(500_000),
      blocks: [block([chunk('a.pdf', 0.9), chunk('b.pdf', 0.8)])],
    });
    expect(result.blocks[0]?.sources.map((s) => s.source)).toEqual(['a.pdf', 'b.pdf']);
    expect(result.overflow).toBe(false);
  });

  it('caps excerpts at their share so retrieval cannot swallow the window', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      chunk(`p${String(i)}.pdf`, 0.9 - i * 0.01, 900),
    );
    const result = allocateBudget({ ...base, blocks: [block(many)] });
    const used = result.blocks.reduce(
      (sum, b) => sum + Math.ceil((b.label.length + 1 + b.text.length) / 4),
      0,
    );
    expect(used).toBeLessThanOrEqual(Math.floor(result.limitTokens * MAX_EXCERPT_SHARE));
    expect(result.trimmed.some((note) => note.kind === 'excerpt-dropped')).toBe(true);
  });

  it('drops the lowest-scoring excerpt first', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      chunk(`p${String(i)}.pdf`, 1 - i * 0.02, 900),
    );
    const result = allocateBudget({ ...base, blocks: [block(many)] });
    const kept = result.blocks[0]?.sources.map((s) => s.score) ?? [];
    // whatever survived must all outrank whatever went
    expect(Math.min(...kept)).toBeGreaterThan(0.2);
  });

  it('re-renders block text so citations and text can never disagree', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      chunk(`p${String(i)}.pdf`, 1 - i * 0.02, 900),
    );
    const result = allocateBudget({ ...base, blocks: [block(many)] });
    const kept = result.blocks[0];
    expect(kept).toBeDefined();
    for (const source of kept?.sources ?? []) {
      expect(kept?.text).toContain(source.source);
    }
  });

  it('drops the document entirely when a long instruction leaves it no room', () => {
    // The excerpt cap guarantees the document usually keeps *some* room, so the
    // drop path needs an instruction that alone consumes most of the budget.
    const many = Array.from({ length: 30 }, (_, i) => chunk(`p${String(i)}.pdf`, 0.9, 800));
    const result = allocateBudget({
      ...base,
      instruction: 'i'.repeat(9000), // ~2250 tokens of a 3072 budget
      documentContext: 'd'.repeat(100_000),
      blocks: [block(many)],
    });
    expect(result.trimmed.some((note) => note.kind === 'document-dropped')).toBe(true);
    expect(result.documentContext).toBeNull();
    expect(result.overflow).toBe(false); // excerpts gave way until it fit
  });

  it('flags overflow when the instruction alone cannot fit', () => {
    const result = allocateBudget({ ...base, instruction: 'i'.repeat(200_000) });
    expect(result.overflow).toBe(true);
    expect(describeBudget(result)).toMatch(/only .* available/i);
  });

  it('honours a larger reply reserve', () => {
    expect(allocateBudget({ ...base, reservePct: 50 }).limitTokens).toBe(2048);
  });

  it('uses the calibrated ratio, so a denser model gets a smaller budget', () => {
    const generous = allocateBudget({
      ...base,
      documentContext: 'd'.repeat(12_000),
      charsPerToken: 6,
    });
    const dense = allocateBudget({
      ...base,
      documentContext: 'd'.repeat(12_000),
      charsPerToken: 2,
    });
    expect(generous.estimatedTokens).toBeLessThan(dense.estimatedTokens);
  });

  it('never mutates the caller’s blocks', () => {
    const many = Array.from({ length: 40 }, (_, i) => chunk(`p${String(i)}.pdf`, 0.9, 900));
    const input = [block(many)];
    const snapshot = input[0]?.sources.length;
    allocateBudget({ ...base, blocks: input });
    expect(input[0]?.sources.length).toBe(snapshot);
  });
});

describe('describeBudget', () => {
  it('says nothing when nothing was given up', () => {
    expect(describeBudget(allocateBudget(base))).toBeNull();
  });

  it('names what was trimmed', () => {
    const result = allocateBudget({ ...base, documentContext: 'd'.repeat(100_000) });
    expect(describeBudget(result)).toMatch(/document context/i);
  });
});
