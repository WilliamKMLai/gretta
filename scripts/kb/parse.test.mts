import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blocksFromPdfPage, blocksFromPlainText, isSupported, parseFile } from './parse.mts';

describe('isSupported', () => {
  it('accepts the documented formats and rejects others', () => {
    for (const name of ['a.txt', 'b.md', 'c.markdown', 'd.pdf', 'e.docx', 'F.PDF']) {
      expect(isSupported(name)).toBe(true);
    }
    for (const name of ['a.key', 'b.pages', 'c', 'd.doc', 'e.pdf.bak']) {
      expect(isSupported(name)).toBe(false);
    }
  });
});

describe('blocksFromPlainText', () => {
  it('splits on blank lines with 1-based paragraph numbers', () => {
    const blocks = blocksFromPlainText('First para.\n\nSecond para.\n\n\nThird.');
    expect(blocks.map((b) => b.paragraph)).toEqual([1, 2, 3]);
    expect(blocks[0]?.page).toBeNull();
  });

  it('joins soft-wrapped lines inside a paragraph', () => {
    expect(blocksFromPlainText('one\ntwo\nthree')[0]?.text).toBe('one two three');
  });

  it('ignores whitespace-only input', () => {
    expect(blocksFromPlainText('   \n\n  \n')).toEqual([]);
  });
});

describe('blocksFromPdfPage', () => {
  it('assembles runs into paragraphs that all carry the page number', () => {
    const blocks = blocksFromPdfPage(
      [
        { str: 'Hello ', hasEOL: false },
        { str: 'world.', hasEOL: true },
        { str: '', hasEOL: true },
        { str: 'Second block.', hasEOL: true },
      ],
      7,
    );
    expect(blocks.map((b) => b.text)).toEqual(['Hello world.', 'Second block.']);
    expect(blocks.every((b) => b.page === 7)).toBe(true);
    expect(blocks.every((b) => b.paragraph === null)).toBe(true);
  });
});

describe('parseFile', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kb-parse-'));
    writeFileSync(join(dir, 'notes.md'), '# Title\n\nBody paragraph.');
    writeFileSync(join(dir, 'empty.txt'), '   \n  ');
    writeFileSync(join(dir, 'broken.pdf'), 'not really a pdf');
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses markdown into blocks', async () => {
    const result = await parseFile(join(dir, 'notes.md'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.blocks).toHaveLength(2);
  });

  it('reports a reason for an empty file instead of throwing', async () => {
    const result = await parseFile(join(dir, 'empty.txt'));
    expect(result).toEqual({ ok: false, reason: 'file has no extractable text' });
  });

  it('reports a reason for an unsupported extension', async () => {
    const result = await parseFile(join(dir, 'nope.key'));
    expect(result.ok).toBe(false);
  });

  // pdf.js falls back to scanning every object in a damaged file, which is
  // genuinely slow — and slower still when the suite runs in parallel.
  it('turns a corrupt PDF into a skip reason rather than an exception', async () => {
    const result = await parseFile(join(dir, 'broken.pdf'));
    expect(result.ok).toBe(false);
  }, 30_000);

  it('reports a reason for a missing file', async () => {
    const result = await parseFile(join(dir, 'ghost.md'));
    expect(result.ok).toBe(false);
  });
});
