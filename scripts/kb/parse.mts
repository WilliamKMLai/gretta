/**
 * Source-file → provenance-bearing blocks (DECISIONS.md ADR-020).
 *
 * Each format yields the most precise locator it can, because the locator is
 * what the pane cites: PDFs carry 1-based page numbers (pdf.js), DOCX and plain
 * text carry 1-based paragraph indices (mammoth for DOCX). Heavy parsers are
 * imported lazily so a text-only corpus never pays to load them, and a failure
 * inside one file returns a typed reason rather than throwing — the indexer
 * records it as "skipped" and keeps going.
 *
 * `.tex` is the one format needing more than a single file's worth of logic —
 * folder-scoped macro expansion (DECISIONS.md ADR-020 amendment) — and lives
 * under tex/, entered here via `parseTexFile`. `ParseContext` is how
 * index-store.mts threads that folder's macro table in; every other format
 * ignores it.
 */
import { extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { MAX_SCAN_ITERATIONS, extractBraceArg } from './brace-scan.mts';
import { blocksFromPlainText } from './blocks.mts';
import { figureId, findFigures } from './figures.mts';
import type { FigureAnchor } from './figures.mts';
import { parseTexFile } from './tex/index.mts';
import type { MacroTable } from './tex/index.mts';
import type { SourceBlock } from './chunk.mts';

export { blocksFromPlainText } from './blocks.mts';

/** A figure found while parsing, with the geometry needed to render it later. */
export interface FoundFigure {
  id: string;
  anchor: FigureAnchor;
}

/** Either the parsed blocks, or a reason the file was skipped (surfaced to UI). */
export type ParseResult =
  { ok: true; blocks: SourceBlock[]; figures?: FoundFigure[] } | { ok: false; reason: string };

/** Per-call context `parseFile` threads to format-specific parsers that need
 * more than just their own file. `.tex` uses the folder macro table; `.pdf`
 * uses `contentHash`, whose presence is also what enables figure detection
 * (ADR-036) — a collection with figures off simply does not pass it. */
export interface ParseContext {
  texMacros?: MacroTable;
  /** The file's content hash; enables figure detection and keys their ids. */
  contentHash?: string | undefined;
}

/** Extensions the companion will attempt, in priority order. */
export const SUPPORTED_EXTENSIONS = [
  '.txt',
  '.md',
  '.markdown',
  '.rst',
  '.org',
  '.adoc',
  '.asciidoc',
  '.pdf',
  '.docx',
  '.tex',
  '.bib',
  '.html',
  '.htm',
] as const;

/** True when a path is worth handing to `parseFile` (drives the folder scan). */
export function isSupported(path: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extname(path).toLowerCase());
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

async function parsePdf(path: string, context?: ParseContext): Promise<ParseResult> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await readFile(path));
  const loadingTask = getDocument({ data, useSystemFonts: true });
  const doc = await loadingTask.promise;
  try {
    const blocks: SourceBlock[] = [];
    const figures: FoundFigure[] = [];
    for (let page = 1; page <= doc.numPages; page += 1) {
      const proxy = await doc.getPage(page);
      const content = await proxy.getTextContent();
      const items = content.items.flatMap((item) =>
        'str' in item ? [{ str: item.str, hasEOL: item.hasEOL }] : [],
      );
      blocks.push(...blocksFromPdfPage(items, page));

      // Figures are opt-in per collection (ADR-036): the caption scan is cheap,
      // but a collection that will never surface figures should not carry them.
      if (context?.contentHash === undefined) continue;
      const viewport = proxy.getViewport({ scale: 1 });
      const positioned = content.items.flatMap((item) =>
        'str' in item
          ? [
              {
                str: item.str,
                transform: item.transform as number[],
                width: item.width,
                height: item.height,
              },
            ]
          : [],
      );
      for (const anchor of findFigures(positioned, page, viewport.width, viewport.height)) {
        const id = figureId(context.contentHash, page, anchor.region);
        figures.push({ id, anchor });
        // The caption becomes its own atomic block, so it is retrievable now
        // and can be enriched with a description later without disturbing the
        // prose chunks around it.
        blocks.push({ text: anchor.caption, page, paragraph: null, figureId: id });
      }
    }
    return blocks.length === 0
      ? { ok: false, reason: 'no extractable text (scanned PDF? OCR is not performed)' }
      : { ok: true, blocks, ...(figures.length === 0 ? {} : { figures }) };
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

/** BibTeX fields worth indexing, in the order their text is concatenated. */
const BIBTEX_TEXT_FIELDS = [
  'title',
  'author',
  'year',
  'journal',
  'booktitle',
  'abstract',
  'note',
  'annote',
  'keywords',
];

/** Entry types with no bibliographic text of their own. */
const BIBTEX_SKIP_TYPES = new Set(['comment', 'string', 'preamble']);

function findUnescapedQuote(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === '"') return i;
  }
  return -1;
}

/** Parses `field = {value}` / `field = "value"` / `field = bareToken` pairs
 * from a BibTeX entry's body (the text between its outer braces). */
function parseBibtexFields(content: string): Map<string, string> {
  const fields = new Map<string, string>();
  const fieldPattern = /([A-Za-z][\w-]*)\s*=\s*/gu;
  let match: RegExpExecArray | null;
  let iterations = 0;
  while ((match = fieldPattern.exec(content)) !== null && iterations < MAX_SCAN_ITERATIONS) {
    iterations += 1;
    const name = (match[1] ?? '').toLowerCase();
    const valueStart = fieldPattern.lastIndex;
    const ch = content[valueStart];
    if (ch === '{') {
      const arg = extractBraceArg(content, valueStart);
      if (!arg) break;
      fields.set(name, arg.content);
      fieldPattern.lastIndex = arg.end;
    } else if (ch === '"') {
      const end = findUnescapedQuote(content, valueStart + 1);
      const stop = end === -1 ? content.length : end;
      fields.set(name, content.slice(valueStart + 1, stop));
      fieldPattern.lastIndex = end === -1 ? content.length : end + 1;
    } else {
      const end = content.indexOf(',', valueStart);
      const stop = end === -1 ? content.length : end;
      fields.set(name, content.slice(valueStart, stop).trim());
      fieldPattern.lastIndex = stop;
    }
  }
  return fields;
}

/**
 * Parses BibTeX entries into one searchable block per entry (not per field —
 * a lone `author` field is a poor retrieval unit, and "this reference" is a
 * natural unit the same way "this paragraph" is for DOCX/txt). `paragraph`
 * is the entry's 1-based ordinal among entries that produced a non-empty
 * block, reusing the existing locator field rather than adding a new one.
 */
export function blocksFromBibtex(text: string): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  let paragraph = 0;
  const entryPattern = /@(\w+)\s*\{\s*([^,\s}]+)\s*,/gu;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(text)) !== null) {
    const type = (match[1] ?? '').toLowerCase();
    const openBraceIndex = match.index + match[0].indexOf('{');
    const entry = extractBraceArg(text, openBraceIndex);
    // Unbalanced trailing entry — nothing more to recover from this point.
    if (!entry) break;
    entryPattern.lastIndex = entry.end;
    if (BIBTEX_SKIP_TYPES.has(type)) continue;
    const fields = parseBibtexFields(entry.content);
    const value = BIBTEX_TEXT_FIELDS.map((field) => fields.get(field))
      .filter((v): v is string => Boolean(v?.trim()))
      .join('. ')
      .trim();
    if (value === '') continue;
    paragraph += 1;
    blocks.push({ text: value, page: null, paragraph });
  }
  return blocks;
}

async function parseBibtex(path: string): Promise<ParseResult> {
  const blocks = blocksFromBibtex(await readFile(path, 'utf8'));
  return blocks.length === 0
    ? { ok: false, reason: 'file has no bibliography entries' }
    : { ok: true, blocks };
}

const HTML_BLOCK_BREAK_TAGS = /<\/(?:p|div|li|h[1-6]|tr|blockquote)>|<br\s*\/?>/giu;

const HTML_NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/gu, (whole, code: string) => {
    if (code.startsWith('#')) {
      return code[1] === 'x' || code[1] === 'X'
        ? String.fromCodePoint(parseInt(code.slice(2), 16))
        : String.fromCodePoint(parseInt(code.slice(1), 10));
    }
    return HTML_NAMED_ENTITIES[code] ?? whole;
  });
}

/**
 * Lightweight tag stripper — not an HTML parser (`fast-xml-parser`, already
 * a dependency, is strict XML and rejects malformed real-world HTML).
 * Best-effort: unclosed tags are left as literal noise rather than causing
 * a failure, matching this file's "typed reason, never throw" style.
 */
export function stripHtml(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/giu, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/giu, '')
    .replace(/<!--[\s\S]*?-->/gu, '');
  // Block-level tags become paragraph breaks before the rest are stripped —
  // the source has no page/paragraph numbering, so this is the one citation-
  // granularity decision for HTML, mirroring how .md is left as plain prose.
  text = text.replace(HTML_BLOCK_BREAK_TAGS, '\n\n');
  text = text.replace(/<[^>]+>/gu, '');
  return decodeHtmlEntities(text);
}

async function parseHtml(path: string): Promise<ParseResult> {
  const blocks = blocksFromPlainText(stripHtml(await readFile(path, 'utf8')));
  return blocks.length === 0
    ? { ok: false, reason: 'file has no extractable text after stripping HTML markup' }
    : { ok: true, blocks };
}

/** Reads and parses a single file into blocks, or reports why it was skipped. */
export async function parseFile(path: string, context?: ParseContext): Promise<ParseResult> {
  const ext = extname(path).toLowerCase();
  try {
    switch (ext) {
      case '.txt':
      case '.md':
      case '.markdown':
      case '.rst':
      case '.org':
      case '.adoc':
      case '.asciidoc': {
        const blocks = blocksFromPlainText(await readFile(path, 'utf8'));
        return blocks.length === 0
          ? { ok: false, reason: 'file has no extractable text' }
          : { ok: true, blocks };
      }
      case '.pdf':
        return await parsePdf(path, context);
      case '.docx':
        return await parseDocx(path);
      case '.tex':
        return await parseTexFile(path, context?.texMacros);
      case '.bib':
        return await parseBibtex(path);
      case '.html':
      case '.htm':
        return await parseHtml(path);
      default:
        return { ok: false, reason: `unsupported file type ${ext}` };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'could not read file' };
  }
}
