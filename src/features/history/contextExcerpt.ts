/**
 * Bounded capture of the document text a generation used (ARCHITECTURE.md §6).
 *
 * History records previously stored `contextSource` — the *kind* of context, so
 * `'selection'` or `'document'` — and nothing else. That is the least useful
 * possible answer: it asserts that a passage informed the generation without
 * saying which passage, so the sources listed underneath cannot be checked
 * against anything. Provenance you cannot audit is decoration.
 *
 * Storing the whole capture is not the fix either. History lives in browser
 * storage, capped at 200 records, and a whole-document capture can run to
 * megabytes — one generation would evict the rest. So the head of the text is
 * kept along with the true length, which is enough to recognise what a record
 * refers to and honest about being partial.
 *
 * Pure: imports nothing, tested directly.
 */

/**
 * Characters retained. Long enough to recognise a paragraph, short enough that
 * two hundred of them cost well under a megabyte in total.
 */
export const CONTEXT_EXCERPT_CHARS = 600;

export interface ContextExcerptLike {
  text: string;
  totalChars: number;
}

/**
 * Truncates at a word boundary where one is available near the limit, so an
 * excerpt does not end mid-word for no reason. Whitespace is collapsed because
 * the excerpt is read, not replayed — the original is in the document.
 */
export function toContextExcerpt(captured: string): ContextExcerptLike | null {
  const normalized = captured.replace(/\s+/gu, ' ').trim();
  if (normalized === '') return null;

  if (normalized.length <= CONTEXT_EXCERPT_CHARS) {
    return { text: normalized, totalChars: normalized.length };
  }

  const clipped = normalized.slice(0, CONTEXT_EXCERPT_CHARS);
  const lastSpace = clipped.lastIndexOf(' ');
  const text = lastSpace > CONTEXT_EXCERPT_CHARS - 60 ? clipped.slice(0, lastSpace) : clipped;
  return { text: text.trimEnd(), totalChars: normalized.length };
}

/** True when the stored excerpt is shorter than what was captured. */
export function isTruncated(excerpt: ContextExcerptLike): boolean {
  return excerpt.text.length < excerpt.totalChars;
}
