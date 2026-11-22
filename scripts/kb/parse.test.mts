import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  blocksFromBibtex,
  blocksFromPdfPage,
  blocksFromPlainText,
  isSupported,
  parseFile,
  stripHtml,
} from './parse.mts';

describe('isSupported', () => {
  it('accepts the documented formats and rejects others', () => {
    for (const name of [
      'a.txt',
      'b.md',
      'c.markdown',
      'd.pdf',
      'e.docx',
      'F.PDF',
      'f.tex',
      'g.bib',
      'h.html',
      'i.htm',
      'j.rst',
      'k.org',
      'l.adoc',
      'm.asciidoc',
    ]) {
      expect(isSupported(name)).toBe(true);
    }
    for (const name of ['a.key', 'b.pages', 'c', 'd.doc', 'e.pdf.bak', 'f.xhtml', 'g.biblatex']) {
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

describe('blocksFromBibtex', () => {
  it('parses brace- and quote-delimited entries into one block each', () => {
    const bib = [
      '@article{doe2020,',
      '  title = {A Study of Things},',
      '  author = {Jane Doe},',
      '  year = {2020},',
      '}',
      '',
      '@book{smith1999,',
      '  title = "Another Book",',
      '  author = "John Smith",',
      '}',
    ].join('\n');
    const blocks = blocksFromBibtex(bib);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.paragraph).toBe(1);
    expect(blocks[0]?.text).toContain('A Study of Things');
    expect(blocks[0]?.text).toContain('Jane Doe');
    expect(blocks[1]?.paragraph).toBe(2);
    expect(blocks[1]?.text).toContain('Another Book');
  });

  it('handles nested braces inside a field value', () => {
    const blocks = blocksFromBibtex('@article{k,\n  title = {The {Quick} Brown Fox},\n}');
    expect(blocks[0]?.text).toContain('Quick');
  });

  it('skips entries with no indexed fields', () => {
    const blocks = blocksFromBibtex(
      '@article{k,\n  doi = {10.1/xyz},\n  url = {http://example.com},\n}',
    );
    expect(blocks).toEqual([]);
  });

  it('ignores @comment and @string entries', () => {
    const bib =
      '@comment{ignore me}\n@string{foo = "bar"}\n@article{k,\n  title = {Real Entry},\n}';
    const blocks = blocksFromBibtex(bib);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toContain('Real Entry');
  });
});

describe('stripHtml', () => {
  it('drops script/style content and produces paragraph breaks at block tags', () => {
    const html =
      '<html><head><style>body{color:red}</style><script>alert(1)</script></head>' +
      '<body><h1>Title</h1><p>First paragraph.</p><p>Second paragraph.</p></body></html>';
    const stripped = stripHtml(html);
    expect(stripped).not.toContain('color:red');
    expect(stripped).not.toContain('alert(1)');
    const blocks = blocksFromPlainText(stripped);
    expect(blocks.map((b) => b.text)).toEqual(['Title', 'First paragraph.', 'Second paragraph.']);
  });

  it('decodes named, decimal, and hex entities', () => {
    expect(stripHtml('Fish &amp; chips &#65; &#x42;&nbsp;end')).toBe('Fish & chips A B end');
  });

  it('replaces out-of-range, zero, and surrogate numeric entities without throwing', () => {
    const raw = 'Bad &#9999999; &#x110000; &#0; &#xD800; ok';
    expect(() => stripHtml(raw)).not.toThrow();
    expect(stripHtml(raw)).toBe('Bad \uFFFD \uFFFD \uFFFD \uFFFD ok');
  });

  it('keeps HTML table cells separated and breaks on section/article/pre/hr tags', () => {
    const html =
      '<article><table><tr><th>Buffer</th><th>Temp</th></tr>' +
      '<tr><td>Vantrellium</td><td>47.3C</td></tr></table>' +
      '<hr/><section>Next</section></article>';
    const blocks = blocksFromPlainText(stripHtml(html));
    expect(blocks.map((b) => b.text)).toEqual(['Buffer Temp', 'Vantrellium 47.3C', 'Next']);
  });

  it('leaves unclosed tags as harmless noise instead of throwing', () => {
    expect(() => stripHtml('<p>Unclosed <b>bold text')).not.toThrow();
    expect(stripHtml('<p>Unclosed <b>bold text')).toContain('bold text');
  });
});

describe('parseFile', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kb-parse-'));
    writeFileSync(join(dir, 'notes.md'), '# Title\n\nBody paragraph.');
    writeFileSync(join(dir, 'empty.txt'), '   \n  ');
    writeFileSync(join(dir, 'broken.pdf'), 'not really a pdf');
    writeFileSync(
      join(dir, 'paper.tex'),
      '\\begin{document}\n\\section{Intro}\nSome findings here.\n\\end{document}',
    );
    writeFileSync(
      join(dir, 'refs.bib'),
      '@article{k,\n  title = {A Reference},\n  author = {A. Author},\n}',
    );
    writeFileSync(join(dir, 'page.html'), '<html><body><p>Hello world.</p></body></html>');
    writeFileSync(join(dir, 'notes.rst'), 'First para.\n\nSecond para.');
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

  it('parses a .tex file by stripping LaTeX markup', async () => {
    const result = await parseFile(join(dir, 'paper.tex'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blocks.map((b) => b.text).join(' ')).toContain('Some findings here.');
      expect(result.blocks.every((b) => b.page === null)).toBe(true);
    }
  });

  it('parses a .bib file into entry blocks', async () => {
    const result = await parseFile(join(dir, 'refs.bib'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0]?.text).toContain('A Reference');
    }
  });

  it('parses a .html file by stripping tags', async () => {
    const result = await parseFile(join(dir, 'page.html'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.blocks[0]?.text).toBe('Hello world.');
  });

  it('parses .rst through the same plain-text path as .md', async () => {
    const result = await parseFile(join(dir, 'notes.rst'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.blocks).toHaveLength(2);
  });
});
