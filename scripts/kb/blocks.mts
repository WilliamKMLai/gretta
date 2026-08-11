/**
 * Plain-text paragraph blocking, shared by every format that ultimately
 * reduces to prose (txt/md/rst/…, PDF via `blocksFromPdfPage`, DOCX, HTML,
 * and the LaTeX reader in tex/). Kept out of parse.mts so tex/index.mts can
 * use it without importing parse.mts — which imports tex/index.mts for the
 * `.tex` case, so the reverse would be a cycle.
 */
import type { SourceBlock } from './chunk.mts';

/** Splits plain text into paragraph blocks on blank lines, 1-based indices. */
export function blocksFromPlainText(text: string): SourceBlock[] {
  const normalized = text.replace(/\r\n?/gu, '\n');
  const blocks: SourceBlock[] = [];
  let paragraph = 0;
  for (const raw of normalized.split(/\n{2,}/u)) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    paragraph += 1;
    blocks.push({ text: trimmed.replace(/[ \t]*\n[ \t]*/gu, ' '), page: null, paragraph });
  }
  return blocks;
}
