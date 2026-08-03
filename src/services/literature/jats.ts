/**
 * Abstracts arrive as markup; GRETTA only ever handles text (DECISIONS.md
 * ADR-026; ARCHITECTURE.md §13.1).
 *
 * Crossref returns abstracts as JATS XML — `<jats:p>`, `<jats:italic>`,
 * `<jats:sec>` and friends — and other sources embed stray HTML. None of it may
 * survive into the app, for the same reason ADR-026 renders Markdown by
 * building React elements rather than setting HTML: an abstract is
 * attacker-influenceable text from a third party, and the codebase has no
 * `dangerouslySetInnerHTML` anywhere by deliberate choice.
 *
 * This converts markup to plain text rather than sanitising it. That is the
 * stronger position and the cheaper one: there is no allowlist to get wrong, no
 * parser differential to exploit, and no path by which a tag could reach the
 * DOM. Note in particular that `DOMParser` is *not* used — it is safe for
 * `text/xml` in principle, but reaching for a parser at all invites someone
 * later to reach for `text/html`, and the whole value here is that no parsing
 * happens.
 *
 * Pure: imports nothing, tested directly.
 */

/** Named entities that actually appear in scholarly abstracts. */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  times: '×',
  deg: '°',
  plusmn: '±',
  micro: 'µ',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  mu: 'μ',
};

/**
 * Elements whose boundaries are meaningful as paragraph breaks. Everything else
 * (emphasis, sub/superscript, inline math) is dropped without leaving a gap, so
 * "H<jats:sub>2</jats:sub>O" reads as "H2O" rather than "H 2 O".
 */
const BLOCK_TAGS = /<\/?(?:jats:)?(?:p|sec|title|abstract|list-item|list|br)\b[^>]*>/giu;

/**
 * Elements whose *contents* are dropped along with their tags. Everywhere else
 * the text between tags is kept, because that is the prose; here it never is,
 * and preserving it would leave `alert(1)` sitting in the middle of an abstract
 * looking like part of the findings. Inert either way — nothing here reaches
 * the DOM — but noise in a citation is still a defect.
 */
const DROP_WITH_CONTENT = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu;

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/gu, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/giu, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

/**
 * Converts a JATS or HTML abstract to plain text.
 *
 * Order matters. Block boundaries become newlines *before* the remaining tags
 * are stripped, or paragraph structure would be lost. Entities are decoded
 * *after* stripping, so an encoded `&lt;script&gt;` in the source decodes to
 * literal text that is never re-examined as markup — decoding first would
 * manufacture a tag out of escaped content, which is the classic ordering bug.
 */
export function abstractToText(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  const withoutInert = raw.replace(DROP_WITH_CONTENT, ' ');
  const withBreaks = withoutInert.replace(BLOCK_TAGS, '\n');
  const stripped = withBreaks.replace(/<[^>]*>/gu, '');
  const decoded = decodeEntities(stripped);

  const normalized = decoded
    .replace(/\r\n?/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/ ?\n ?/gu, '\n')
    .replace(/\n{2,}/gu, '\n\n')
    .trim();

  return normalized === '' ? null : normalized;
}

/**
 * Crossref returns titles as arrays, occasionally empty, occasionally with a
 * translated second entry. The first non-empty entry is the work's title; the
 * rest are not discarded silently anywhere the user can see, they simply are
 * not the title.
 */
export function firstNonEmpty(values: readonly string[] | undefined): string | null {
  if (values === undefined) return null;
  for (const value of values) {
    const text = abstractToText(value);
    // Titles and journal names are single-line by nature, but deposits contain
    // real line breaks — Crossref returned "Base editing using CRISPR/Cas9 in\n
    // Drosophila", which renders as a broken title in the results list. The
    // paragraph structure `abstractToText` preserves is right for an abstract
    // and wrong here.
    if (text !== null) return text.replace(/\s+/gu, ' ').trim();
  }
  return null;
}
