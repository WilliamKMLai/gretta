/**
 * Fixture-driven acceptance tests for the `.tex` reader, numbered to match
 * the design's own test list. The fixture is `__fixtures__/paper/` —
 * `main.tex` + `sections/methods.tex` + `refs.bib` — a two-file paper where
 * macros are defined only in `main.tex` but used in `sections/methods.tex`,
 * which is the entire reason pass 1 (macros.mts) exists.
 *
 * Test 9 (headings) is adapted from the design's literal wording: headings
 * are inlined as their own marked paragraph rather than a separate metadata
 * field, because the chunker (chunk.mts) has no heading concept for any
 * format today and adding one is a larger, separately-flagged change. What's
 * asserted here is what that decision actually promises: no raw `\section`
 * markup in the text, and the heading's own text present as its own block.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildMacroTable } from './macros.mts';
import type { MacroTable } from './macros.mts';
import { parseTexFile } from './index.mts';
import { parseFile } from '../parse.mts';

const PAPER_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'paper');

/** Joins a parsed file's blocks back into one string for substring
 * assertions — the same shape the chunker (chunk.mts) ultimately consumes,
 * and where the design's "must/must not contain" test cases are pitched.
 * `stripTex` alone still has the source file's own soft line-wraps in it;
 * joining wrapped lines within a paragraph is `blocksFromPlainText`'s job,
 * one layer up. */
async function renderedTextOf(path: string, table: MacroTable): Promise<string> {
  const result = await parseTexFile(path, table);
  if (!result.ok) throw new Error(`fixture failed to parse: ${result.reason}`);
  return result.blocks.map((b) => b.text).join('\n\n');
}

describe('.tex reader — fixture acceptance tests', () => {
  let table: MacroTable;
  let mainOut: string;
  let methodsOut: string;

  beforeAll(async () => {
    const built = await buildMacroTable([
      { absolute: join(PAPER_DIR, 'main.tex'), source: 'main.tex' },
      { absolute: join(PAPER_DIR, 'sections', 'methods.tex'), source: 'sections/methods.tex' },
    ]);
    table = built.table;
    mainOut = await renderedTextOf(join(PAPER_DIR, 'main.tex'), table);
    methodsOut = await renderedTextOf(join(PAPER_DIR, 'sections', 'methods.tex'), table);
  });

  it('1. expands macros defined only in main.tex when used in sections/methods.tex', () => {
    // 12,481 also appears in main.tex's own verbatim decoy block, so this
    // must assert against methods.tex's output specifically.
    expect(methodsOut).toContain('12,481');
    expect(methodsOut).toContain('80 token');
    expect(methodsOut).not.toContain('\\dsize');
    expect(methodsOut).not.toContain('\\unit');
  });

  it('2. expands argument macros, keeping math inside the argument intact', () => {
    expect(methodsOut).toContain('4 min');
    expect(methodsOut).toContain('TODO: Add the $m = 20$ run');
  });

  it('3. keeps escaped percent/dollar signs literal while stripping a real trailing comment', () => {
    expect(mainOut).toContain('61\\% to 78\\%');
    expect(mainOut).toContain('\\$40');
    expect(mainOut).toContain('\\$60');
    expect(mainOut).not.toContain('confirm currency');
    expect(mainOut).not.toContain('verify this stat');
  });

  it('4. drops a commented-out section heading entirely (comment decoy)', () => {
    expect(mainOut).not.toContain('Ghost Section');
  });

  it('5. seals verbatim/lstlisting character-exact, and parses correctly after them', () => {
    expect(mainOut).toContain('# score = {unbalanced');
    expect(mainOut).toContain('return x % 2');
    expect(mainOut).toContain('{unbalanced brace in a code sample');
    expect(mainOut).toContain('100% raw, not a real LaTeX comment');
    // Discussion follows both blocks in the source; if the unbalanced brace
    // or bare "%" leaked out of sealing, downstream brace/comment parsing
    // would corrupt or swallow this.
    expect(mainOut).toContain(
      'quality differences cannot be attributed to unequal compute rather than to the retrieval method itself.',
    );
  });

  it('6. drops the preamble when \\begin{document} is present, keeps the whole body otherwise', () => {
    expect(mainOut).not.toContain('documentclass');
    expect(mainOut).not.toContain('amsmath');
    expect(mainOut).not.toContain('graphicx');
    // sections/methods.tex has no \begin{document} at all — the whole
    // fragment must survive, not just be discarded as "preamble".
    expect(methodsOut).toContain('Methods');
    expect(methodsOut).toContain('cached on disk');
  });

  it('7. keeps figure/table captions, drops the tabular source', () => {
    expect(mainOut).toContain('Overview of the retrieval-matched compute pipeline.');
    expect(mainOut).toContain('Retrieval quality across datasets at matched compute.');
    expect(mainOut).not.toContain('\\toprule');
    expect(mainOut).not.toContain('MIMIC-Ext & 0.612');
    expect(mainOut).not.toContain('pipeline.png');
  });

  it('8. normalizes TeX accent escapes to Unicode', () => {
    expect(mainOut).toContain('Björk');
    expect(mainOut).toContain('naïve');
    expect(mainOut).toContain('Erdős');
    expect(mainOut).toContain('café');
    expect(mainOut).toContain('Santé');
  });

  it('9. section titles read as prose, not as raw \\section{...} markup', () => {
    expect(mainOut).not.toContain('\\section');
    expect(mainOut).toContain('Introduction');
    expect(mainOut).toContain('Discussion');
    expect(methodsOut).not.toContain('\\section');
    expect(methodsOut).toContain('Methods');
  });

  it('10. preserves citations and refs verbatim, brackets included', () => {
    expect(methodsOut).toContain('\\citep[cf.][]{lindqvist2021}');
    expect(methodsOut).toContain('\\eqref{eq:bm25}');
  });

  it('keeps the hyperparameter grid intact with no raw macro names left over', () => {
    expect(methodsOut).toContain('$k_1 \\in \\{0.9, 1.2, 1.5\\}$');
    expect(methodsOut).toContain('$b = 0.75$');
    expect(methodsOut).not.toMatch(/\\dsize|\\unit|\\todo\b/u);
  });

  it('renders itemize entries with a leading "- "', () => {
    expect(methodsOut).toContain(
      '- Embeddings are computed once per collection and cached on disk.',
    );
  });

  it('drops title/author/date from body text', () => {
    expect(mainOut).not.toContain('\\title');
    expect(mainOut).not.toContain('\\author');
    expect(mainOut).not.toContain('A. Researcher');
  });
});

describe('.tex reader — entry point', () => {
  it('parseTexFile produces non-empty blocks with a null page/paragraph locator', async () => {
    const built = await buildMacroTable([
      { absolute: join(PAPER_DIR, 'main.tex'), source: 'main.tex' },
      { absolute: join(PAPER_DIR, 'sections', 'methods.tex'), source: 'sections/methods.tex' },
    ]);
    const result = await parseTexFile(join(PAPER_DIR, 'sections', 'methods.tex'), built.table);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blocks.length).toBeGreaterThan(0);
      expect(result.blocks.every((b) => b.page === null)).toBe(true);
      const joined = result.blocks.map((b) => b.text).join(' ');
      expect(joined).toContain('12,481');
    }
  });

  it('parseFile dispatches .tex through the same pipeline, defaulting to no macros', async () => {
    const result = await parseFile(join(PAPER_DIR, 'main.tex'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const joined = result.blocks.map((b) => b.text).join(' ');
      expect(joined).toContain('Introduction');
      expect(joined).not.toContain('\\section');
    }
  });

  it('parseFile threads a supplied macro table through to the .tex case', async () => {
    const built = await buildMacroTable([
      { absolute: join(PAPER_DIR, 'main.tex'), source: 'main.tex' },
      { absolute: join(PAPER_DIR, 'sections', 'methods.tex'), source: 'sections/methods.tex' },
    ]);
    const result = await parseFile(join(PAPER_DIR, 'sections', 'methods.tex'), {
      texMacros: built.table,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const joined = result.blocks.map((b) => b.text).join(' ');
      expect(joined).toContain('12,481');
      expect(joined).not.toContain('\\dsize');
    }
  });
});
