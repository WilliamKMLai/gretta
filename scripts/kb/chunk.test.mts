import { describe, expect, it } from 'vitest';
import { type SourceBlock, chunkBlocks } from './chunk.mts';

const para = (text: string, paragraph: number): SourceBlock => ({ text, page: null, paragraph });
const page = (text: string, page: number): SourceBlock => ({ text, page, paragraph: null });

describe('chunkBlocks', () => {
  it('returns nothing for empty or whitespace-only input', () => {
    expect(chunkBlocks([])).toEqual([]);
    expect(chunkBlocks([para('   ', 1), para('\n\n', 2)])).toEqual([]);
  });

  it('keeps small blocks together in a single chunk', () => {
    const chunks = chunkBlocks([para('alpha', 1), para('beta', 2)], {
      targetChars: 1000,
      overlapChars: 0,
      maxChars: 1000,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('alpha\n\nbeta');
    expect(chunks[0]?.startBlock).toBe(0);
    expect(chunks[0]?.endBlock).toBe(1);
  });

  it('splits into multiple chunks once the target is exceeded', () => {
    const blocks = [para('a'.repeat(60), 1), para('b'.repeat(60), 2), para('c'.repeat(60), 3)];
    const chunks = chunkBlocks(blocks, { targetChars: 100, overlapChars: 0, maxChars: 500 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('carries provenance from the first primary block of each chunk', () => {
    const blocks = [page('a'.repeat(80), 3), page('b'.repeat(80), 4)];
    const chunks = chunkBlocks(blocks, { targetChars: 100, overlapChars: 0, maxChars: 500 });
    expect(chunks[0]?.page).toBe(3);
    expect(chunks[1]?.page).toBe(4);
    expect(chunks[0]?.paragraph).toBeNull();
  });

  it('prepends word-aligned overlap to subsequent chunks', () => {
    const blocks = [para('one two three four five', 1), para('six seven eight', 2)];
    const chunks = chunkBlocks(blocks, { targetChars: 24, overlapChars: 10, maxChars: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    // second chunk begins with overlap text from the first, not the raw block
    expect(chunks[1]?.text.startsWith('six seven eight')).toBe(false);
    expect(chunks[1]?.text).toContain('six seven eight');
  });

  it('splits an oversized single block below maxChars, keeping its locator', () => {
    const huge = `${'word '.repeat(200).trim()}.`;
    const chunks = chunkBlocks([page(huge, 7)], {
      targetChars: 400,
      overlapChars: 0,
      maxChars: 300,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.page).toBe(7);
  });
});
