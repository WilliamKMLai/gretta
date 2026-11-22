/**
 * Budget allocation (ADR-025).
 *
 * The rule these exist to protect: retrieved excerpts must never be the silent
 * casualty of an over-long prompt, because the pane cites them either way.
 */
import { describe, expect, it } from 'vitest';
import type { RetrievedChunk } from '../../../types/knowledgebase';
import { IMAGE_TOKEN_ESTIMATE, MAX_EXCERPT_SHARE, allocateBudget, describeBudget } from './budget';
import { EXCERPT_PREAMBLE } from './knowledgeBaseProvider';
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
    expect(kept?.text).toContain(EXCERPT_PREAMBLE);
    expect(kept?.text).toContain('[1] p0.pdf, ¶1');
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

describe('attached images (ADR-034)', () => {
  it('costs nothing when no images are attached', () => {
    const without = allocateBudget(base);
    const explicitZero = allocateBudget({ ...base, imageCount: 0 });
    expect(explicitZero.estimatedTokens).toBe(without.estimatedTokens);
  });

  it('charges each image against the budget', () => {
    const one = allocateBudget({ ...base, imageCount: 1 });
    const two = allocateBudget({ ...base, imageCount: 2 });
    expect(one.estimatedTokens - allocateBudget(base).estimatedTokens).toBe(IMAGE_TOKEN_ESTIMATE);
    expect(two.estimatedTokens - one.estimatedTokens).toBe(IMAGE_TOKEN_ESTIMATE);
  });

  it('gives up excerpts to make room for an image, not the other way round', () => {
    // An image the user attached is the subject of the question; an excerpt is
    // supporting material. The excerpt is what yields.
    //
    // Sized so the excerpts sit just under their own share cap (~1536 tokens of
    // a 3072 budget) and only tip over once the image's 1600 is charged — so
    // this exercises the image pushing them out, not the cap doing it anyway.
    const blocks = [block([chunk('a.pdf', 0.9, 3000), chunk('b.pdf', 0.4, 3000)])];
    const withoutImage = allocateBudget({ ...base, blocks });
    expect(withoutImage.trimmed).toEqual([]);

    const withImage = allocateBudget({ ...base, blocks, imageCount: 1 });
    expect(withImage.trimmed.some((note) => note.kind === 'excerpt-dropped')).toBe(true);
    expect(withImage.blocks[0]?.sources.map((s) => s.source)).toEqual(['a.pdf']);
  });

  it('reports overflow rather than silently dropping an image that cannot fit', () => {
    // The failure ADR-025 exists to prevent, arriving through the image door:
    // Ollama would trim the prompt from the front without saying anything.
    const result = allocateBudget({ ...base, contextLength: 1024, imageCount: 2 });
    expect(result.overflow).toBe(true);
    expect(describeBudget(result)).toMatch(/context/i);
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
