/**
 * Depth-aware brace matching shared by the BibTeX field parser (parse.mts)
 * and the LaTeX macro/command parsers (tex/*.mts) — both need to know where
 * a value actually ends when it can contain nested braces
 * (`\textbf{Bold \emph{and italic}}`, `title = {The {Quick} Brown Fox}`).
 */

/** Iteration ceiling for regex-driven scan loops — a bailout against a
 * pathological input, not a realistic count, so a malformed file degrades
 * to "stopped early" rather than hanging ingestion. */
export const MAX_SCAN_ITERATIONS = 5000;

/**
 * Depth-aware scan of a brace-delimited argument, `text[openBraceIndex]` being
 * the opening `{`. Returns null on an unbalanced brace so callers can bail
 * out of that one command/field rather than looping or throwing.
 */
export function extractBraceArg(
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
