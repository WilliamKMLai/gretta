/**
 * Drafting a search query from a passage (DECISIONS.md ADR-028).
 *
 * This runs against the user's own Ollama, so the passage never leaves the
 * machine at this stage. What the model produces is a *proposal*: it goes into
 * an editable field the user reads before anything is transmitted. The prompt
 * is therefore written to produce something a human can check at a glance —
 * short, keyword-shaped, no prose — rather than something maximally clever.
 *
 * Pure: no imports, tested directly.
 */

/**
 * Well below ADR-028's 256-character cap. A drafted query that approaches the
 * cap is describing a field rather than naming a paper, and search APIs that
 * AND their terms punish exactly that.
 */
export const DRAFT_TARGET_CHARS = 120;

/**
 * Fewer, more distinctive terms.
 *
 * The first version asked for six to twelve keywords and got
 * "structural biology machine learning protein structure prediction … design
 * complex atomic resolution" — generic words that describe the field rather
 * than identify the work. They are not merely useless: OpenAlex and PubMed both
 * **AND** their terms, so every vague word is another condition a paper must
 * satisfy, and a long query converges on zero results. Naming the specific
 * things is what finds the specific papers.
 */
export const DRAFT_QUERY_SYSTEM = [
  'You convert a passage of scientific writing into a literature search query.',
  'Reply with the query and nothing else: no explanation, no label, no commentary.',
  'Name only the most distinctive things in the passage: specific tools, methods,',
  'proteins, genes, organisms, or techniques. Prefer proper names over categories.',
  'Use three to six terms. Fewer is better.',
  'Put any multi-word name in double quotes.',
  'Never include generic descriptors such as: recent, advances, novel, approach,',
  'method, tool, analysis, design, complex, resolution, study, research,',
  'or the name of a whole field such as biology, chemistry, machine learning.',
  'Do not copy sentences from the passage. Keep it on one line.',
].join(' ');

export function buildDraftPrompt(passage: string): string {
  return `Passage:\n${passage}\n\nSearch query:`;
}

/**
 * Pulls a usable query out of whatever the model returned.
 *
 * Small local models ignore "reply with nothing else" often enough that this
 * cannot be optimistic: they add a preamble, wrap the query in quotes, or offer
 * a numbered list of alternatives. The first non-empty line is taken, common
 * decorations are stripped, and the result is truncated at a word boundary.
 *
 * Truncating rather than rejecting matters because the user sees and can edit
 * whatever comes out — a slightly clipped query they can fix is more useful
 * than an empty box and an error.
 */
export function extractDraftedQuery(raw: string): string {
  const firstLine =
    raw
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? '';

  const labelled = firstLine
    // "Search query:", "Query:", "1." and similar leading labels.
    .replace(/^(?:search\s+)?query\s*[:\-\u2014]\s*/iu, '')
    .replace(/^\d+[.)]\s*/u, '')
    .replace(/[\u201C\u201D]/gu, '"')
    .trim();

  /*
   * A model asked to quote multi-word names often returns a comma-separated
   * list: `"Precision medicine", "target tractability"`. Stripping the outer
   * quotes then produced `Precision medicine", "target tractability` — a
   * mangled string with unbalanced quotes that no search API can parse.
   *
   * So quoted phrases are extracted as whole units first, and only a string
   * with none of them falls through to the outer-quote strip.
   */
  const phrases = [...labelled.matchAll(/"([^"]+)"/gu)]
    .map((match) => match[1]?.trim() ?? '')
    .filter((phrase) => phrase !== '');

  const cleaned =
    phrases.length > 0
      ? phrases.map((phrase) => (phrase.includes(' ') ? `"${phrase}"` : phrase)).join(' ')
      : labelled
          .replace(/^["']+|["']+$/gu, '')
          .replace(/\s+/gu, ' ')
          .trim();

  if (cleaned.length <= DRAFT_TARGET_CHARS) return cleaned;

  const clipped = cleaned.slice(0, DRAFT_TARGET_CHARS);
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trim();
}
