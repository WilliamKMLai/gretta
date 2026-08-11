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

const MAX_COMMAND_ITERATIONS = 5000;

/**
 * Depth-aware scan of a brace-delimited argument, `text[openBraceIndex]` being
 * the opening `{`. Shared by the LaTeX and BibTeX parsers below, both of which
 * need to know where a value actually ends when it can contain nested braces
 * (`\textbf{Bold \emph{and italic}}`, `title = {The {Quick} Brown Fox}`).
 * Returns null on an unbalanced brace so callers can bail out of that one
 * command/field rather than looping or throwing.
 */
function extractBraceArg(
  text: string,
  openBraceIndex: number,
): { content: string; end: number } | null {
  let depth = 0;
  for (let i = openBraceIndex; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return { content: text.slice(openBraceIndex + 1, i), end: i + 1 };
    }
  }
  return null;
}

function replaceBracedCommand(
  text: string,
  names: readonly string[],
  render: (inner: string) => string,
): string {
  const pattern = new RegExp(`\\\\(?:${names.join('|')})\\*?(?:\\[[^\\]]*\\])?\\s*\\{`, 'u');
  let result = text;
  for (let iteration = 0; iteration < MAX_COMMAND_ITERATIONS; iteration += 1) {
    const match = pattern.exec(result);
    if (!match) break;
    const openBrace = match.index + match[0].length - 1;
    const arg = extractBraceArg(result, openBrace);
    // Unbalanced — stop trying this command set; the residual `\name{` token
    // is left as slightly noisy literal text rather than looping forever.
    if (!arg) break;
    result = result.slice(0, match.index) + render(arg.content) + result.slice(arg.end);
  }
  return result;
}

/** Removes `\name{...}` for each name in `names`, discarding the argument. */
function dropBracedCommand(text: string, names: readonly string[]): string {
  return replaceBracedCommand(text, names, () => '');
}

/** Replaces `\name{...}` with its argument's own text, optionally as its own paragraph. */
function unwrapBracedCommand(
  text: string,
  names: readonly string[],
  options: { forceBreak: boolean },
): string {
  return replaceBracedCommand(text, names, (inner) =>
    options.forceBreak ? `\n\n${inner}\n\n` : inner,
  );
}

/** Removes bare `\name` tokens (no argument) for each name in `names`. */
function dropBarewordCommand(text: string, names: readonly string[]): string {
  return text.replace(new RegExp(`\\\\(?:${names.join('|')})\\*?\\b\\s*`, 'gu'), '');
}

/** Environments whose *content* is noise for retrieval, not just their markup. */
const NON_PROSE_ENVIRONMENTS = [
  'equation',
  'align',
  'gather',
  'eqnarray',
  'math',
  'displaymath',
  'figure',
  'table',
  'tikzpicture',
  'verbatim',
  'lstlisting',
  'algorithm',
  'algorithmic',
];

/**
 * Drops each blocklisted environment's `\begin{name}...\end{name}` span,
 * content included — math source and figure/table markup pollute retrieval
 * more than they help. An unclosed instance strips from `\begin{name}` to
 * end of the (already document-scoped) text: erring toward removing more
 * rather than leaking raw verbatim/tikz source as if it were prose.
 */
function dropEnvironments(text: string, names: readonly string[]): string {
  let result = text;
  for (const name of names) {
    result = result.replace(
      new RegExp(`\\\\begin\\{${name}\\*?\\}[\\s\\S]*?\\\\end\\{${name}\\*?\\}`, 'gu'),
      '',
    );
    result = result.replace(new RegExp(`\\\\begin\\{${name}\\*?\\}[\\s\\S]*$`, 'u'), '');
  }
  return result;
}

function stripMath(text: string): string {
  return text
    .replace(/\$\$[\s\S]*?\$\$/gu, '')
    .replace(/\$[^$]*?\$/gu, '')
    .replace(/\\\[[\s\S]*?\\\]/gu, '')
    .replace(/\\\([\s\S]*?\\\)/gu, '');
}

/** Strips a `%` comment to end of line. Does not fully tokenize backslash
 * escaping, so a literal `\\%` (escaped backslash then a real comment) is
 * left un-stripped — a documented, rare edge case, not a full TeX lexer. */
function stripLatexComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/(?<!\\)%.*$/u, ''))
    .join('\n');
}

/** Slices to the `\begin{document}...\end{document}` body when present
 * (skipping the preamble), else treats the whole file as body — a bare
 * `.tex` fragment meant for `\input` has no document environment at all. */
function scopeToDocumentBody(text: string): string {
  const begin = /\\begin\{document\}/u.exec(text);
  if (!begin) return text;
  const bodyStart = begin.index + begin[0].length;
  const end = /\\end\{document\}/u.exec(text.slice(bodyStart));
  return end ? text.slice(bodyStart, bodyStart + end.index) : text.slice(bodyStart);
}

const NO_TEXT_BRACED_COMMANDS = [
  'label',
  'ref',
  'eqref',
  'pageref',
  'cite',
  'citep',
  'citet',
  'includegraphics',
  'usepackage',
  'documentclass',
  'input',
  'include',
  'bibliography',
  'bibliographystyle',
  'newcommand',
  'renewcommand',
  'hspace',
  'vspace',
];

const NO_TEXT_BAREWORD_COMMANDS = ['maketitle', 'tableofcontents', 'noindent', 'newpage', 'clearpage'];

const SECTIONING_COMMANDS = ['section', 'subsection', 'subsubsection', 'paragraph', 'part', 'chapter'];

const INLINE_FORMATTING_COMMANDS = ['emph', 'textbf', 'textit', 'textsc', 'underline', 'footnote', 'caption'];

/**
 * Strips LaTeX markup down to readable prose. Math (`$...$`, `\[...\]`, and
 * environments like `equation`/`align`) and non-prose environments (figures,
 * tables, verbatim/code, tikz) are dropped entirely rather than linearized —
 * rendering math as text is a losing battle that only pollutes retrieval
 * with `\frac{a}{b}` noise. Sectioning and inline-formatting commands are
 * unwrapped to their argument text so headings and emphasized words stay
 * searchable.
 */
export function stripLatex(source: string): string {
  let text = scopeToDocumentBody(source);
  text = stripLatexComments(text);
  text = dropEnvironments(text, NON_PROSE_ENVIRONMENTS);
  // Remaining (prose-bearing) environments: drop the begin/end markers and
  // bare \item labels, keep their content.
  text = text.replace(/\\begin\{[^}]*\}/gu, '').replace(/\\end\{[^}]*\}/gu, '');
  text = text.replace(/\\item\b(?:\[[^\]]*\])?\s*/gu, '');
  text = stripMath(text);
  text = dropBracedCommand(text, NO_TEXT_BRACED_COMMANDS);
  text = dropBarewordCommand(text, NO_TEXT_BAREWORD_COMMANDS);
  text = unwrapBracedCommand(text, SECTIONING_COMMANDS, { forceBreak: true });
  text = unwrapBracedCommand(text, INLINE_FORMATTING_COMMANDS, { forceBreak: false });
  text = text.replace(/\\\\/gu, '\n');
  text = text.replace(/[ \t]*\n{3,}/gu, '\n\n');
  return text.trim();
}

async function parseLatex(path: string): Promise<ParseResult> {
  const blocks = blocksFromPlainText(stripLatex(await readFile(path, 'utf8')));
  return blocks.length === 0
    ? { ok: false, reason: 'file has no extractable text after stripping LaTeX markup' }
    : { ok: true, blocks };
}

/** BibTeX fields worth indexing, in the order their text is concatenated. */
const BIBTEX_TEXT_FIELDS = ['title', 'author', 'year', 'journal', 'booktitle', 'abstract', 'note', 'annote', 'keywords'];

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
  while ((match = fieldPattern.exec(content)) !== null && iterations < MAX_COMMAND_ITERATIONS) {
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
  return blocks.length === 0 ? { ok: false, reason: 'file has no bibliography entries' } : { ok: true, blocks };
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
export async function parseFile(path: string): Promise<ParseResult> {
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
        return await parsePdf(path);
      case '.docx':
        return await parseDocx(path);
      case '.tex':
        return await parseLatex(path);
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
