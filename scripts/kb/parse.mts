/**
 * Source-file → provenance-bearing blocks (DECISIONS.md ADR-020).
 *
 * Each format yields the most precise locator it can, because the locator is
 * what the pane cites: PDFs carry 1-based page numbers (pdf.js), DOCX and plain
 * text carry 1-based paragraph indices (mammoth for DOCX). Heavy parsers are
 * imported lazily so a text-only corpus never pays to load them, and a failure
 * inside one file returns a typed reason rather than throwing — the indexer
 * records it as "skipped" and keeps going.
 */
import { extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { SourceBlock } from './chunk.mts';

/** Either the parsed blocks, or a reason the file was skipped (surfaced to UI). */
export type ParseResult = { ok: true; blocks: SourceBlock[] } | { ok: false; reason: string };

/** Extensions the companion will attempt, in priority order. */
export const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.pdf', '.docx'] as const;

/** True when a path is worth handing to `parseFile` (drives the folder scan). */
export function isSupported(path: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extname(path).toLowerCase());
}

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

/**
 * Groups a PDF page's text items into paragraph-ish blocks. pdf.js exposes
 * positioned text runs, not paragraphs; `hasEOL` marks line ends, so runs are
 * joined into lines and lines split into blocks on blank lines. Every block
 * from a page carries that page number — the citation users actually want.
 */
export function blocksFromPdfPage(
  items: { str: string; hasEOL: boolean }[],
  page: number,
): SourceBlock[] {
  let text = '';
  for (const item of items) text += item.hasEOL ? `${item.str}\n` : item.str;
  return blocksFromPlainText(text).map((block) => ({
    text: block.text,
    page,
    paragraph: null,
  }));
}

async function parsePdf(path: string): Promise<ParseResult> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await readFile(path));
  const loadingTask = getDocument({ data, useSystemFonts: true });
  const doc = await loadingTask.promise;
  try {
    const blocks: SourceBlock[] = [];
    for (let page = 1; page <= doc.numPages; page += 1) {
      const content = await (await doc.getPage(page)).getTextContent();
      const items = content.items.flatMap((item) =>
        'str' in item ? [{ str: item.str, hasEOL: item.hasEOL }] : [],
      );
      blocks.push(...blocksFromPdfPage(items, page));
    }
    return blocks.length === 0
      ? { ok: false, reason: 'no extractable text (scanned PDF? OCR is not performed)' }
      : { ok: true, blocks };
  } finally {
    // destroy() lives on the loading task in pdf.js v6, not the document proxy.
    await loadingTask.destroy();
  }
}

async function parseDocx(path: string): Promise<ParseResult> {
  const { extractRawText } = await import('mammoth');
  const { value } = await extractRawText({ path });
  const blocks = blocksFromPlainText(value);
  return blocks.length === 0 ? { ok: false, reason: 'document has no text' } : { ok: true, blocks };
}

/** Reads and parses a single file into blocks, or reports why it was skipped. */
export async function parseFile(path: string): Promise<ParseResult> {
  const ext = extname(path).toLowerCase();
  try {
    switch (ext) {
      case '.txt':
      case '.md':
      case '.markdown': {
        const blocks = blocksFromPlainText(await readFile(path, 'utf8'));
        return blocks.length === 0
          ? { ok: false, reason: 'file has no extractable text' }
          : { ok: true, blocks };
      }
      case '.pdf':
        return await parsePdf(path);
      case '.docx':
        return await parseDocx(path);
      default:
        return { ok: false, reason: `unsupported file type ${ext}` };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'could not read file' };
  }
}
