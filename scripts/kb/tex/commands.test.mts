import { describe, expect, it } from 'vitest';
import { handleCommands } from './commands.mts';

describe('handleCommands', () => {
  it('unwraps inline formatting to its argument text', () => {
    expect(handleCommands('This is \\emph{important} background.', true)).toBe(
      'This is important background.',
    );
  });

  it('resolves nested commands by re-scanning to a fixed point', () => {
    expect(handleCommands('\\textbf{Bold \\emph{and italic}} text', true)).toBe(
      'Bold and italic text',
    );
  });

  it('extracts a section title as its own paragraph', () => {
    expect(handleCommands('Before.\n\\section{Methods}\nAfter.', true)).toBe(
      'Before.\n\n\nMethods\n\n\nAfter.',
    );
  });

  it('preserves citations and refs verbatim, including citep pre/post brackets', () => {
    const text = 'See \\citep[cf.][]{lindqvist2021} and \\eqref{eq:bm25}.';
    expect(handleCommands(text, true)).toBe(text);
  });

  it('drops citations/refs when citation preservation is disabled', () => {
    expect(handleCommands('See \\cite{foo}.', false)).toBe('See .');
  });

  it('drops includegraphics and its argument entirely', () => {
    expect(handleCommands('\\includegraphics{plot.png} caption text', true)).toBe(' caption text');
  });

  it('drops title/author/date, argument included', () => {
    expect(handleCommands('\\title{My Paper}\\author{A. Researcher}', true)).toBe('');
  });

  it('drops an unknown bareword command with no argument', () => {
    expect(handleCommands('Before \\xspace after', true)).toBe('Before  after');
  });

  it("keeps an unknown command's braced argument text, dropping the command", () => {
    expect(handleCommands('\\hlbox{important text}', true)).toBe('important text');
  });

  it('inlines footnote/thanks content into surrounding text', () => {
    expect(handleCommands('A claim.\\footnote{See appendix.}', true)).toBe('A claim.See appendix.');
  });

  it('replaces \\quad/\\qquad with a space rather than joining the words around them', () => {
    expect(handleCommands('budget\\qquad limit', true)).toBe('budget  limit');
    expect(handleCommands('a\\quad b', true)).toBe('a  b');
  });

  it('drops \\hspace/\\vspace, argument included', () => {
    expect(handleCommands('Before\\hspace{1em}After', true)).toBe('BeforeAfter');
  });
});
