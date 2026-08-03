/**
 * The transmission gate (DECISIONS.md ADR-028).
 *
 * ADR-028 permits exactly one kind of outbound text: a search query the user
 * has seen in its final form and explicitly sent. This module is where that
 * rule is made mechanical.
 *
 * `ApprovedQuery` is a branded string. Every search client accepts only an
 * `ApprovedQuery`, and the only way to obtain one is `approveQuery`, so a raw
 * string — a selection, a prompt draft, a paragraph of the user's manuscript —
 * cannot reach a network call without passing these checks first. The check is
 * a compile-time one; it costs nothing at runtime and it cannot be forgotten.
 *
 * What the brand does NOT enforce is that a human actually read the string.
 * That is a UI obligation (the search surface renders the exact bytes in an
 * editable field and requires a distinct send action), named here so the
 * limitation is not mistaken for a guarantee.
 *
 * Pure: imports nothing, tested directly.
 */

/**
 * ADR-028's structural defence against a derived query that is really document
 * text. A keyword or Boolean query fits comfortably; a paragraph does not.
 * Flagged in the ADR as a judgement to re-check against real derived queries.
 */
export const MAX_QUERY_CHARS = 256;

/** Why a candidate query may not be transmitted. */
export type QueryRejection = 'empty' | 'too-long' | 'multiline';

/**
 * A string cleared for transmission. Obtainable only from `approveQuery`; the
 * brand is erased at runtime and exists purely to make the gate unbypassable
 * in the type system.
 */
export type ApprovedQuery = string & { readonly __brand: 'approved-query' };

export type QueryApproval =
  { ok: true; query: ApprovedQuery } | { ok: false; reason: QueryRejection; message: string };

/**
 * Collapses runs of whitespace and trims. Applied before length checking so
 * the cap measures the string that would actually be sent, not the one that
 * was typed — otherwise padding could smuggle a long query past a short one.
 */
export function normalizeQuery(raw: string): string {
  return raw.replace(/[^\S\r\n]+/gu, ' ').trim();
}

/**
 * The sole route from an arbitrary string to a transmittable one.
 *
 * Rejects a multi-line candidate outright rather than joining the lines: a
 * keyword query has no line breaks, so their presence means a block of prose
 * was pasted or derived, and silently flattening it would transmit exactly what
 * ADR-028 forbids while appearing to comply.
 */
export function approveQuery(raw: string): QueryApproval {
  if (/[\r\n]/u.test(raw)) {
    return {
      ok: false,
      reason: 'multiline',
      message: 'A search query must be a single line of keywords, not a passage of text.',
    };
  }

  const normalized = normalizeQuery(raw);

  if (normalized === '') {
    return { ok: false, reason: 'empty', message: 'Enter something to search for.' };
  }

  if (normalized.length > MAX_QUERY_CHARS) {
    return {
      ok: false,
      reason: 'too-long',
      message:
        `A search query is limited to ${String(MAX_QUERY_CHARS)} characters ` +
        `(this one is ${String(normalized.length)}). Shorten it to keywords — ` +
        'a query this long is document text, and document text is never transmitted.',
    };
  }

  return { ok: true, query: normalized as ApprovedQuery };
}

/**
 * Reads an approved query back as a plain string, for display and for building
 * a request URL. Named rather than inlined so that `as string` casts do not
 * accumulate at call sites and blur where the boundary is.
 */
export function queryText(query: ApprovedQuery): string {
  return query;
}
