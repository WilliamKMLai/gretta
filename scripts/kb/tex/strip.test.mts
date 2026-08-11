import { describe, expect, it } from 'vitest';
import { stripTex } from './strip.mts';
import type { MacroTable } from './macros.mts';

const NO_MACROS: MacroTable = new Map();

describe('stripTex', () => {
  it('returns effectively empty output for a comment-only file', () => {
    expect(stripTex('% just a comment\n% another', NO_MACROS)).toBe('');
  });

  it('seals an unclosed verbatim block to the end rather than leaking its content', () => {
    const out = stripTex('Before.\n\\begin{verbatim}\nsome raw code\n', NO_MACROS);
    expect(out).toContain('Before.');
    expect(out).toContain('some raw code');
  });

  it('treats the whole file as body when there is no \\begin{document}', () => {
    expect(stripTex('Just a fragment with \\emph{emphasis}.', NO_MACROS)).toBe(
      'Just a fragment with emphasis.',
    );
  });

  it('drops an unclosed figure but still keeps its caption', () => {
    const out = stripTex(
      'Before.\n\\begin{figure}\n\\caption{A lost figure.}\nraw junk',
      NO_MACROS,
    );
    expect(out).toContain('Before.');
    expect(out).toContain('A lost figure.');
    expect(out).not.toContain('raw junk');
  });

  it('never throws on malformed input (unbalanced braces)', () => {
    expect(() =>
      stripTex('\\emph{unterminated and \\textbf{also unterminated', NO_MACROS),
    ).not.toThrow();
  });
});
