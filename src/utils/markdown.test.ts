/** Markdown reading for model output (ADR-026). */
import { describe, expect, it } from 'vitest';
import { markdownToPlainText, parseInline, parseMarkdown } from './markdown';

describe('parseInline', () => {
  it('reads bold, italic, and inline code', () => {
    expect(parseInline('a **b** c *d* e `f`')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'strong', value: 'b' },
      { type: 'text', value: ' c ' },
      { type: 'em', value: 'd' },
      { type: 'text', value: ' e ' },
      { type: 'code', value: 'f' },
    ]);
  });

  it('accepts underscore emphasis', () => {
    expect(parseInline('__x__')).toEqual([{ type: 'strong', value: 'x' }]);
    expect(parseInline('_y_')).toEqual([{ type: 'em', value: 'y' }]);
  });

  it('captures a link without making it clickable', () => {
    expect(parseInline('see [docs](https://example.com)')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'link', value: 'docs', href: 'https://example.com' },
    ]);
  });

  it('captures links whose URLs contain balanced parentheses (SICI DOIs, Wikipedia)', () => {
    const nodes = parseInline('(see [Lancet](https://doi.org/10.1016/s0140-6736(97)11096-0))');
    expect(nodes).toEqual([
      { type: 'text', value: '(see ' },
      {
        type: 'link',
        value: 'Lancet',
        href: 'https://doi.org/10.1016/s0140-6736(97)11096-0',
      },
      { type: 'text', value: ')' },
    ]);
  });

  it('preserves intraword underscores in snake_case and subscripts', () => {
    expect(parseInline('Compare alpha_1 and alpha_2 with _real_ and __bold__')).toEqual([
      { type: 'text', value: 'Compare alpha_1 and alpha_2 with ' },
      { type: 'em', value: 'real' },
      { type: 'text', value: ' and ' },
      { type: 'strong', value: 'bold' },
    ]);
    expect(markdownToPlainText('Set top_p and top_k in foo__bar__baz.')).toBe(
      'Set top_p and top_k in foo__bar__baz.',
    );
  });

  it('leaves unmatched punctuation as text', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([{ type: 'text', value: '2 * 3 = 6' }]);
  });
});

describe('parseMarkdown', () => {
  it('reads headings up to level 3', () => {
    const blocks = parseMarkdown('# One\n\n## Two\n\n### Three\n\n#### Four');
    expect(blocks.filter((b) => b.type === 'heading').map((b) => b.level)).toEqual([1, 2, 3, 3]);
  });

  it('joins wrapped lines into one paragraph and splits on blank lines', () => {
    const blocks = parseMarkdown('one\ntwo\n\nthree');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'paragraph' });
  });

  it('reads fenced code with its language', () => {
    const blocks = parseMarkdown('```ts\nconst a = 1;\n```');
    expect(blocks[0]).toEqual({ type: 'code', language: 'ts', value: 'const a = 1;' });
  });

  it('treats an unterminated fence as code, so a cut stream still renders', () => {
    const blocks = parseMarkdown('```\nhalf a code block');
    expect(blocks[0]).toMatchObject({ type: 'code', value: 'half a code block' });
  });

  it('does not read markup inside a code fence', () => {
    const blocks = parseMarkdown('```\n# not a heading\n**not bold**\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('code');
  });

  it('groups consecutive bullets into one list', () => {
    const blocks = parseMarkdown('- a\n- b\n- c');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: false });
    expect(blocks[0]?.type === 'list' && blocks[0].items).toHaveLength(3);
  });

  it('distinguishes numbered lists', () => {
    const blocks = parseMarkdown('1. a\n2. b');
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: true });
  });

  it('reads quotes and rules', () => {
    const blocks = parseMarkdown('> quoted\n\n---');
    expect(blocks.map((b) => b.type)).toEqual(['quote', 'rule']);
  });

  it('never throws on arbitrary text', () => {
    for (const input of ['', '   ', '***', '[](', '`', '#', '> ', '```']) {
      expect(() => parseMarkdown(input)).not.toThrow();
    }
  });
});

describe('markdownToPlainText', () => {
  it('removes syntax so a document never receives literal markers', () => {
    const out = markdownToPlainText('## Results\n\nThe **effect** was *large*.');
    expect(out).toBe('Results\n\nThe effect was large.');
    expect(out).not.toContain('#');
    expect(out).not.toContain('*');
  });

  it('keeps list structure readable', () => {
    expect(markdownToPlainText('- one\n- two')).toBe('• one\n• two');
    expect(markdownToPlainText('1. one\n2. two')).toBe('1. one\n2. two');
  });

  it('keeps code verbatim', () => {
    expect(markdownToPlainText('```\nx = 1\n```')).toBe('x = 1');
  });

  it('preserves a link and its destination', () => {
    expect(markdownToPlainText('[docs](https://example.com)')).toBe('docs (https://example.com)');
  });

  it('drops horizontal rules, which have no plain-text meaning', () => {
    expect(markdownToPlainText('a\n\n---\n\nb')).toBe('a\n\nb');
  });
});
