/** Context-excerpt tests: bounded storage without silent truncation. */
import { describe, expect, it } from 'vitest';
import { CONTEXT_EXCERPT_CHARS, isTruncated, toContextExcerpt } from './contextExcerpt';

describe('toContextExcerpt', () => {
  it('keeps a short passage whole', () => {
    const excerpt = toContextExcerpt('A single sentence of context.');
    expect(excerpt).toEqual({ text: 'A single sentence of context.', totalChars: 29 });
  });

  it('collapses whitespace, since the excerpt is read rather than replayed', () => {
    expect(toContextExcerpt('two   spaced\n\nlines')?.text).toBe('two spaced lines');
  });

  it('records the true length so truncation is visible', () => {
    const long = 'word '.repeat(500);
    const excerpt = toContextExcerpt(long);
    expect(excerpt?.text.length).toBeLessThanOrEqual(CONTEXT_EXCERPT_CHARS);
    expect(excerpt?.totalChars).toBeGreaterThan(CONTEXT_EXCERPT_CHARS);
  });

  it('truncates at a word boundary rather than mid-word', () => {
    const excerpt = toContextExcerpt('hepatocyte '.repeat(200));
    expect(excerpt?.text.endsWith('hepatocyte')).toBe(true);
  });

  it('does not hunt for a boundary that is far from the limit', () => {
    // A single enormous token has no usable boundary; a hard cut is correct.
    const excerpt = toContextExcerpt('x'.repeat(2000));
    expect(excerpt?.text).toHaveLength(CONTEXT_EXCERPT_CHARS);
  });

  it('returns null for empty or whitespace-only capture', () => {
    expect(toContextExcerpt('')).toBeNull();
    expect(toContextExcerpt('   \n ')).toBeNull();
  });

  it('bounds a whole-document capture so one record cannot evict the rest', () => {
    const document = 'sentence about proteins. '.repeat(50_000);
    const excerpt = toContextExcerpt(document);
    expect(excerpt?.text.length).toBeLessThanOrEqual(CONTEXT_EXCERPT_CHARS);
  });
});

describe('isTruncated', () => {
  it('is false for a whole passage and true for a clipped one', () => {
    expect(isTruncated({ text: 'short', totalChars: 5 })).toBe(false);
    expect(isTruncated({ text: 'short', totalChars: 5000 })).toBe(true);
  });
});
