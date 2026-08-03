/**
 * Pure structural chunker for the knowledge-base companion (DECISIONS.md
 * ADR-020; ARCHITECTURE.md §16). Runs in the Node companion but imports
 * nothing platform-specific, so it is unit-tested in the normal vitest suite
 * alongside `scripts/kb/*.test.mts` — the same "pure logic is tested TS"
 * discipline as `services/ollama/ndjson.ts`.
 *
 * Contract: parsing (impure, format-specific — pdf.js / mammoth / plain text)
 * emits an ordered `SourceBlock[]` carrying provenance (page for PDFs,
 * paragraph index otherwise). This module groups blocks into overlapping
 * retrieval chunks WITHOUT re-reading files. Provenance of a chunk is the
 * locator of its first *primary* block (overlap carried from the previous
 * chunk does not move the citation). Substitution is never re-scanned and no
 * expression language is involved — chunking is deterministic string work.
 */

/** One provenance-bearing unit of source text produced by a parser. */
export interface SourceBlock {
  /** Block text, already whitespace-normalized by the parser. */
  text: string;
  /** 1-based page number for paginated sources (PDF); null otherwise. */
  page: number | null;
  /** 1-based paragraph index within the source; null when unknown. */
  paragraph: number | null;
}

/** A retrieval chunk: contiguous blocks, optionally prefixed with overlap. */
export interface Chunk {
  /** Chunk text (overlap prefix + the primary blocks' text). */
  text: string;
  /** Index of the first primary block (into the parser's block array). */
  startBlock: number;
  /** Index of the last primary block (inclusive). */
  endBlock: number;
  /** Page of the first primary block — the citation page. */
  page: number | null;
  /** Paragraph of the first primary block — the citation paragraph. */
  paragraph: number | null;
}

/** Chunk sizing, in characters (a stable proxy for tokens; see ADR-020). */
export interface ChunkOptions {
  /** Soft target size; a chunk closes once adding the next block exceeds it. */
  targetChars: number;
  /** Trailing characters of the previous chunk prepended to the next. */
  overlapChars: number;
  /** Hard ceiling; a single block larger than this is split before chunking. */
  maxChars: number;
}

/** Defaults justified in ADR-020: ~2 KB (~512 tok) chunks, ~256-char overlap. */
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetChars: 2000,
  overlapChars: 256,
  maxChars: 3000,
};

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z0-9"'([])/u;

/**
 * Splits one oversized block into sub-blocks under `maxChars`, preferring
 * sentence boundaries, then whitespace, then a hard cut. Locators are
 * inherited from the parent block so provenance survives the split.
 */
function splitOversizedBlock(block: SourceBlock, maxChars: number): SourceBlock[] {
  if (block.text.length <= maxChars) return [block];

  const pieces: string[] = [];
  let remainder = block.text;
  while (remainder.length > maxChars) {
    const window = remainder.slice(0, maxChars);
    const sentenceCut = lastMatchIndex(window, SENTENCE_BOUNDARY);
    const cut = sentenceCut > 0 ? sentenceCut : lastWhitespace(window, maxChars);
    pieces.push(remainder.slice(0, cut).trim());
    remainder = remainder.slice(cut).trim();
  }
  if (remainder !== '') pieces.push(remainder);

  return pieces
    .filter((text) => text !== '')
    .map((text) => ({ text, page: block.page, paragraph: block.paragraph }));
}

/** Index just past the last regex match in `text`, or -1 when none matches. */
function lastMatchIndex(text: string, pattern: RegExp): number {
  const global = new RegExp(pattern, `${pattern.flags.replace('g', '')}g`);
  let end = -1;
  for (const match of text.matchAll(global)) {
    end = match.index + match[0].length;
  }
  return end;
}

/** Last whitespace index before `limit`, or `limit` when the run is unbroken. */
function lastWhitespace(text: string, limit: number): number {
  for (let i = Math.min(limit, text.length) - 1; i > 0; i -= 1) {
    if (/\s/u.test(text[i] ?? '')) return i;
  }
  return limit;
}

/** The last `overlapChars` of `text`, snapped to a leading word boundary. */
function tailOverlap(text: string, overlapChars: number): string {
  if (overlapChars <= 0 || text.length <= overlapChars)
    return text.length <= overlapChars ? text : '';
  const tail = text.slice(text.length - overlapChars);
  const space = tail.search(/\s/u);
  return (space === -1 ? tail : tail.slice(space + 1)).trim();
}

/**
 * Groups parser blocks into overlapping chunks. Greedy: accumulate blocks
 * until the next would exceed `targetChars`, emit, then seed the next chunk
 * with a word-aligned tail of the emitted text. Blocks over `maxChars` are
 * pre-split. Empty blocks are dropped. Deterministic and allocation-light.
 */
export function chunkBlocks(
  blocks: readonly SourceBlock[],
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Chunk[] {
  const prepared: SourceBlock[] = [];
  for (const block of blocks) {
    if (block.text.trim() === '') continue;
    prepared.push(...splitOversizedBlock(block, options.maxChars));
  }
  if (prepared.length === 0) return [];

  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let startBlock = 0;
  let firstBlock: SourceBlock | null = null;
  let overlap = '';

  const flush = (endBlock: number): void => {
    if (firstBlock === null) return;
    const body = current.join('\n\n');
    const text = overlap === '' ? body : `${overlap}\n\n${body}`;
    chunks.push({
      text,
      startBlock,
      endBlock,
      page: firstBlock.page,
      paragraph: firstBlock.paragraph,
    });
    overlap = tailOverlap(body, options.overlapChars);
  };

  for (let i = 0; i < prepared.length; i += 1) {
    const block = prepared[i];
    if (block === undefined) continue;
    const addition = block.text.length + (current.length > 0 ? 2 : 0);
    if (currentLen > 0 && currentLen + addition > options.targetChars) {
      flush(i - 1);
      current = [];
      currentLen = 0;
      startBlock = i;
      firstBlock = null;
    }
    if (firstBlock === null) {
      firstBlock = block;
      startBlock = i;
    }
    current.push(block.text);
    currentLen += addition;
  }
  flush(prepared.length - 1);

  return chunks;
}
