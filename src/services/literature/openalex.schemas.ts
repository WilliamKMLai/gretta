/**
 * Zod validation and pure mapping for OpenAlex payloads (ARCHITECTURE.md §13.2).
 * Split from `openalex.ts` to keep both files inside the 300-line limit; the
 * client owns transport and pacing, this owns shapes.
 *
 * One field is deliberately absent and must stay absent: `is_retracted`.
 * ADR-029 rejects it as an authority because it collapses retractions,
 * corrections, and expressions of concern into a single boolean. A live check
 * against the Wakefield MMR paper returned a 2004 correction *and* a 2010
 * retraction as separate typed notices from Crossref — exactly the distinction
 * a boolean destroys.
 */
import { z } from 'zod';
import type { LiteratureRecord, OpenAlexSignals, WorkType } from '../../types/literature';

/**
 * The source object embedded in a work is *dehydrated*: identity and
 * open-access status, but no standing. `summary_stats` and `apc_usd` exist only
 * on the full record at `/sources`, so reading them here returned null for a
 * journal with thousands of citations — and null reads as "checked, absent"
 * when it meant "never fetched", the confusion ADR-029 exists to prevent.
 */
export const DehydratedSourceSchema = z.object({
  id: z.string().optional(),
  display_name: z.string().nullable().optional(),
  is_in_doaj: z.boolean().optional(),
  is_oa: z.boolean().optional(),
});

export const FullSourceSchema = z.object({
  id: z.string(),
  apc_usd: z.number().nullable().optional(),
  summary_stats: z
    .object({
      '2yr_mean_citedness': z.number().optional(),
      h_index: z.number().optional(),
    })
    .optional(),
});

export const WorkSchema = z.object({
  id: z.string().optional(),
  doi: z.string().nullable().optional(),
  display_name: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  publication_year: z.number().nullable().optional(),
  type: z.string().nullable().optional(),
  authorships: z
    .array(
      z.object({
        author: z.object({ display_name: z.string().optional() }).optional(),
      }),
    )
    .optional(),
  cited_by_count: z.number().optional(),
  fwci: z.number().nullable().optional(),
  is_paratext: z.boolean().optional(),
  cited_by_percentile_year: z.object({ min: z.number().optional() }).nullable().optional(),
  /** Word → positions. OpenAlex distributes abstracts only in this form. */
  abstract_inverted_index: z.record(z.string(), z.array(z.number())).nullable().optional(),
  primary_location: z
    .object({
      source: DehydratedSourceSchema.nullable().optional(),
      landing_page_url: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export const ResponseSchema = z.object({ results: z.array(WorkSchema) });
export const SourceResponseSchema = z.object({ results: z.array(FullSourceSchema) });

export type OpenAlexWork = z.infer<typeof WorkSchema>;

/** Venue standing, fetched separately and keyed by full OpenAlex source id. */
export interface VenueStanding {
  meanCitedness: number | null;
  hIndex: number | null;
  apcUsd: number | null;
}

/** OpenAlex returns DOIs as full URLs; the app keys on the bare identifier. */
export function bareDoi(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '').toLowerCase();
}

/** OpenAlex ids are URLs; its `ids.openalex` filter wants the bare key. */
export function shortId(id: string): string {
  return id.replace(/^https?:\/\/openalex\.org\//iu, '');
}

/**
 * Rebuilds an abstract from OpenAlex's inverted index.
 *
 * This matters more than its size suggests. A live run found that only one
 * Crossref record in five carries an abstract at all, because deposit is
 * optional and most publishers skip it — which leaves ADR-029's local re-rank
 * embedding little more than titles. OpenAlex is already being called for
 * credibility signals, so backfilling abstracts from the same response is the
 * cheapest way to give the re-ranker something to work with.
 *
 * Gaps are possible: the index is a map of word to positions, and a position
 * nothing claims produces a hole. Holes are dropped rather than filled with a
 * placeholder, since the result is fed to an embedding model, not read aloud.
 */
export function fromInvertedIndex(
  index: Readonly<Record<string, number[]>> | null | undefined,
): string | null {
  if (index === null || index === undefined) return null;

  // An explicit position map rather than a sparse array. `filter` does skip
  // array holes, but relying on that is the sort of subtlety that reads as a
  // bug six months later — and the type system cannot see holes either.
  const byPosition = new Map<number, string>();
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) {
      if (Number.isInteger(position) && position >= 0) byPosition.set(position, word);
    }
  }

  const text = [...byPosition.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, word]) => word)
    .join(' ')
    .trim();
  return text === '' ? null : text;
}

export function toSignals(
  work: OpenAlexWork,
  venues: ReadonlyMap<string, VenueStanding>,
): OpenAlexSignals {
  const source = work.primary_location?.source ?? null;
  const standing = source?.id === undefined ? undefined : venues.get(source.id);
  return {
    venueKnown: source !== null,
    venueInDoaj: source?.is_in_doaj ?? null,
    venueIsOa: source?.is_oa ?? null,
    venueMeanCitedness: standing?.meanCitedness ?? null,
    venueHIndex: standing?.hIndex ?? null,
    venueApcUsd: standing?.apcUsd ?? null,
    fwci: work.fwci ?? null,
    // `min` is the percentile floor OpenAlex reports for the work's year.
    citedByPercentileYear: work.cited_by_percentile_year?.min ?? null,
    citedByCount: work.cited_by_count ?? null,
    isParatext: work.is_paratext ?? null,
  };
}

/** OpenAlex `type` mapped onto the domain's. Preprints are labelled, not demoted. */
function toWorkType(raw: string | null | undefined): WorkType {
  switch (raw) {
    case 'article':
      return 'article';
    case 'preprint':
      return 'preprint';
    case 'review':
      return 'review';
    case 'editorial':
    case 'paratext':
      return 'editorial';
    case 'letter':
      return 'letter';
    case 'erratum':
      return 'erratum';
    case 'book-chapter':
      return 'chapter';
    case 'dataset':
      return 'dataset';
    default:
      return raw === null || raw === undefined ? 'other' : 'article';
  }
}

/**
 * Maps a work into the domain record.
 *
 * OpenAlex earns its place as a *search* source rather than only an enrichment
 * one because it matches over titles, abstracts, and full text with a relevance
 * model, where Crossref's index is bibliographic and poor at named entities —
 * a query naming specific tools returns loosely-related older work there while
 * the papers introducing those tools never surface. Local re-ranking cannot
 * repair that: it is precision over a pool, and no ordering of the wrong
 * twenty-five records produces the right one.
 */
export function toRecord(work: OpenAlexWork): LiteratureRecord | null {
  const doi = bareDoi(work.doi);
  const title = work.display_name ?? work.title ?? null;
  const id = work.id ?? null;
  if (title === null || title.trim() === '' || (doi === null && id === null)) return null;

  const source = work.primary_location?.source ?? null;

  return {
    id: `openalex:${id ?? doi ?? title}`,
    doi,
    pmid: null,
    arxivId: null,
    openAlexId: id,
    title: title.trim(),
    authors: (work.authorships ?? []).flatMap((authorship) => {
      const name = authorship.author?.display_name?.trim() ?? '';
      if (name === '') return [];
      // OpenAlex gives one display name; CSL wants a literal in `family`.
      return [{ family: name, given: null }];
    }),
    containerTitle: source?.display_name ?? null,
    issued:
      typeof work.publication_year === 'number'
        ? { year: work.publication_year, month: null, day: null }
        : null,
    abstract: fromInvertedIndex(work.abstract_inverted_index),
    type: toWorkType(work.type),
    url:
      work.primary_location?.landing_page_url ?? (doi === null ? null : `https://doi.org/${doi}`),
    discoveredVia: 'openalex',
  };
}
