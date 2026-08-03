/**
 * OpenAlex client (DECISIONS.md ADR-028, ADR-029).
 *
 * ADR-029 makes OpenAlex the credibility backbone: it is the only openly
 * licensed source that carries venue-level standing (DOAJ listing, two-year
 * mean citedness, h-index, article-processing charge) alongside work-level,
 * age-normalised citation measures. Without it every badge reads "not checked".
 *
 * Its role here is *enrichment*, not search — it is asked about identifiers
 * that other sources already returned. ADR-028 requires that to be disclosed in
 * its own words at the point of enabling, because it is a different disclosure
 * from a search query: it tells OpenAlex what the user is reading, not what
 * they searched for.
 *
 * One thing this client deliberately does not do is read `is_retracted`.
 * ADR-029 rejects that field — it collapses retractions, corrections, and
 * expressions of concern into one boolean, and has mislabelled a corrected
 * paper as retracted. Retraction status comes from Crossref's `update-to`,
 * which preserves the notice type. The field is not requested here and must not
 * be added later without revisiting that decision.
 */
import { LiteratureError } from '../../types/errors';
import type { OpenAlexSignals } from '../../types/literature';
import type { HttpTransport, LiteratureClientConfig } from './client.types';
import type { LiteratureRecord } from '../../types/literature';
import { queryText, type ApprovedQuery } from './query';
import {
  ResponseSchema,
  SourceResponseSchema,
  bareDoi,
  fromInvertedIndex,
  shortId,
  toRecord,
  toSignals,
  type OpenAlexWork,
  type VenueStanding,
} from './openalex.schemas';
import { backoffMs, minIntervalMs, parseRateLimit } from './etiquette';

const DEFAULT_BASE_URL = 'https://api.openalex.org';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

/**
 * DOIs per OR-filtered request. Deliberately below OpenAlex's documented
 * ceiling for `|` lists: the exact ceiling is a number this codebase would
 * rather not encode from memory (ADR-028), and a conservative chunk costs one
 * extra request on a large result set.
 */
export const ENRICH_CHUNK_SIZE = 25;

/**
 * Preprint servers matched by name rather than by OpenAlex source id.
 *
 * The ids were previously hardcoded from memory and returned nothing — the
 * exact failure ADR-028 warns about, where a number copied from recollection
 * acquires authority it has not earned. Names are matched against the record
 * that comes back, so a wrong guess produces no results *visibly* rather than
 * silently filtering everything out server-side.
 */
const PREPRINT_SERVERS = /arxiv|biorxiv|medrxiv|chemrxiv|research\s*square/iu;

/** What enrichment yields for one record. */
export interface OpenAlexEnrichment {
  openAlexId: string | null;
  signals: OpenAlexSignals;
  /**
   * Abstract reconstructed from OpenAlex's inverted index, or null. A live run
   * found only one Crossref record in five carries an abstract, because deposit
   * is optional and most publishers skip it — so this is the practical source of
   * the text ADR-029's local re-ranker embeds.
   */
  abstract: string | null;
}

export interface OpenAlexClient {
  /**
   * Relevance search over titles, abstracts, and full text.
   *
   * `fromYear` is a filter, not a ranking input. ADR-029 keeps relevance,
   * credibility, and recency on separate axes and refuses to sum them; a date
   * bound is a constraint the user states, which is a different thing from a
   * weight the tool applies invisibly.
   */
  search(
    query: ApprovedQuery,
    limit: number,
    fromYear: number | null,
    signal?: AbortSignal,
  ): Promise<LiteratureRecord[]>;

  /**
   * Relevance search restricted to named preprint servers.
   *
   * None of the preprint servers can be searched directly from a task pane.
   * bioRxiv and medRxiv publish no keyword search API at all. arXiv publishes
   * one, but `export.arxiv.org` sends no CORS headers, so a browser cannot call
   * it — a client for it was written, tested, and deleted, because it could
   * only ever have worked outside the webview. OpenAlex indexes all three.
   */
  searchPreprints(
    query: ApprovedQuery,
    limit: number,
    fromYear: number | null,
    signal?: AbortSignal,
  ): Promise<LiteratureRecord[]>;
  /**
   * Looks up venue signals, citation measures, and abstracts by DOI.
   *
   * Every requested DOI appears in the result. A DOI OpenAlex does not know
   * yields `venueKnown: false` with null measures — checked, nothing found —
   * whereas a DOI omitted from the map would be indistinguishable from one
   * never checked, which is the distinction ADR-029 is built around. A failed
   * request omits nothing: it returns no entries at all, and the caller leaves
   * `CredibilitySignals.openAlex` null.
   */
  enrich(dois: readonly string[], signal?: AbortSignal): Promise<Map<string, OpenAlexEnrichment>>;
}

const defaultTransport: HttpTransport = (url, init) => fetch(url, init);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function createOpenAlexClient(config: LiteratureClientConfig = {}): OpenAlexClient {
  const transport = config.transport ?? defaultTransport;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const apiKey = config.apiKey?.trim() ?? '';

  let pacingMs = config.initialPacingMs ?? minIntervalMs(null);
  let lastRequestAt = 0;

  async function request(path: string, signal?: AbortSignal): Promise<unknown> {
    /*
     * OpenAlex retired its `mailto` polite pool in February 2026 and now
     * requires an API key. Unkeyed callers get about a cent of daily budget —
     * a handful of searches — and then 429s, which is why a search that worked
     * yesterday can quietly return nothing today. The key is free.
     */
    const separator = path.includes('?') ? '&' : '?';
    const url =
      apiKey === ''
        ? `${baseUrl}${path}`
        : `${baseUrl}${path}${separator}api_key=${encodeURIComponent(apiKey)}`;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const elapsed = Date.now() - lastRequestAt;
      if (elapsed < pacingMs) await sleep(pacingMs - elapsed);

      const controller = new AbortController();
      const onAbort = (): void => {
        controller.abort();
      };
      if (signal !== undefined) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      const timer = setTimeout(onAbort, timeoutMs);

      let response: Response;
      try {
        response = await transport(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
      } catch (cause) {
        if (signal?.aborted === true) throw cause;
        throw new LiteratureError('offline', 'openalex', 'Could not reach OpenAlex.', { cause });
      } finally {
        clearTimeout(timer);
        lastRequestAt = Date.now();
        signal?.removeEventListener('abort', onAbort);
      }

      pacingMs = minIntervalMs(parseRateLimit(response.headers));

      if (response.status === 429 || response.status >= 500) {
        if (attempt === MAX_ATTEMPTS - 1) {
          const rateLimited = response.status === 429;
          throw new LiteratureError(
            rateLimited ? 'rate-limited' : 'http',
            'openalex',
            rateLimited && apiKey === ''
              ? 'OpenAlex has cut you off. Without an API key you get only a trial ' +
                  'allowance per day. Keys are free — create one at openalex.org and add ' +
                  'it under Settings → Literature.'
              : `OpenAlex is rate-limiting or unavailable (HTTP ${String(response.status)}).`,
            { code: String(response.status) },
          );
        }
        await sleep(backoffMs(attempt, response.headers.get('Retry-After')));
        continue;
      }

      if (!response.ok) {
        throw new LiteratureError(
          'http',
          'openalex',
          `OpenAlex returned HTTP ${String(response.status)}.`,
          { code: String(response.status) },
        );
      }

      try {
        return await response.json();
      } catch (cause) {
        throw new LiteratureError(
          'invalid-response',
          'openalex',
          'OpenAlex returned a response that could not be read as JSON.',
          { cause },
        );
      }
    }

    throw new LiteratureError('http', 'openalex', 'OpenAlex did not respond successfully.');
  }

  /** Batched lookup of full source records for the venues a page references. */
  async function fetchVenues(
    works: readonly OpenAlexWork[],
    signal?: AbortSignal,
  ): Promise<Map<string, VenueStanding>> {
    const standing = new Map<string, VenueStanding>();
    const ids = [
      ...new Set(
        works
          .map((work) => work.primary_location?.source?.id)
          .filter((id): id is string => id !== undefined),
      ),
    ];
    if (ids.length === 0) return standing;

    for (const batch of chunk(ids, ENRICH_CHUNK_SIZE)) {
      const filter = batch.map(shortId).join('|');
      const payload = await request(
        `/sources?filter=ids.openalex:${filter}&per-page=${String(batch.length)}` +
          `&select=id,apc_usd,summary_stats`,
        signal,
      );
      const parsed = SourceResponseSchema.safeParse(payload);
      if (!parsed.success) continue;
      for (const source of parsed.data.results) {
        standing.set(source.id, {
          meanCitedness: source.summary_stats?.['2yr_mean_citedness'] ?? null,
          hIndex: source.summary_stats?.h_index ?? null,
          apcUsd: source.apc_usd ?? null,
        });
      }
    }

    return standing;
  }

  return {
    async search(
      query: ApprovedQuery,
      limit: number,
      fromYear: number | null,
      signal?: AbortSignal,
    ): Promise<LiteratureRecord[]> {
      const perPage = Math.max(1, Math.min(limit, 100));
      const filters = ['type:article|review|preprint'];
      if (fromYear !== null) filters.push(`from_publication_date:${String(fromYear)}-01-01`);

      const payload = await request(
        `/works?search=${encodeURIComponent(queryText(query))}` +
          `&filter=${filters.join(',')}&per-page=${String(perPage)}`,
        signal,
      );

      const parsed = ResponseSchema.safeParse(payload);
      if (!parsed.success) return [];
      return parsed.data.results
        .map(toRecord)
        .filter((record): record is LiteratureRecord => record !== null);
    },

    async searchPreprints(
      query: ApprovedQuery,
      limit: number,
      fromYear: number | null,
      signal?: AbortSignal,
    ): Promise<LiteratureRecord[]> {
      const perPage = Math.max(1, Math.min(limit, 100));
      const filters = ['type:preprint'];
      if (fromYear !== null) filters.push(`from_publication_date:${String(fromYear)}-01-01`);

      const payload = await request(
        `/works?search=${encodeURIComponent(queryText(query))}` +
          `&filter=${filters.join(',')}&per-page=${String(perPage)}`,
        signal,
      );

      const parsed = ResponseSchema.safeParse(payload);
      if (!parsed.success) return [];
      return parsed.data.results
        .map(toRecord)
        .filter((record): record is LiteratureRecord => record !== null)
        .filter(
          (record) =>
            record.containerTitle === null || PREPRINT_SERVERS.test(record.containerTitle),
        );
    },

    async enrich(
      dois: readonly string[],
      signal?: AbortSignal,
    ): Promise<Map<string, OpenAlexEnrichment>> {
      const found = new Map<string, OpenAlexEnrichment>();
      if (dois.length === 0) return found;

      for (const batch of chunk(dois, ENRICH_CHUNK_SIZE)) {
        const filter = batch.map((doi) => encodeURIComponent(doi)).join('|');
        const payload = await request(
          `/works?filter=doi:${filter}&per-page=${String(batch.length)}`,
          signal,
        );

        const parsed = ResponseSchema.safeParse(payload);
        // A malformed payload leaves these DOIs unenriched rather than
        // asserting absent signals for them.
        if (!parsed.success) continue;

        // Second pass: venue standing lives on the full source record, not on
        // the dehydrated one embedded in a work. A failure here propagates
        // rather than being swallowed, so the caller leaves the whole OpenAlex
        // signal group null — "not checked" — instead of reporting standing as
        // absent for a journal that simply was not looked up.
        const venues = await fetchVenues(parsed.data.results, signal);

        for (const work of parsed.data.results) {
          const doi = bareDoi(work.doi);
          if (doi === null) continue;
          found.set(doi, {
            openAlexId: work.id ?? null,
            signals: toSignals(work, venues),
            abstract: fromInvertedIndex(work.abstract_inverted_index),
          });
        }

        // Requested DOIs OpenAlex did not return are known-absent, not unknown.
        for (const doi of batch) {
          const key = doi.toLowerCase();
          if (found.has(key)) continue;
          found.set(key, {
            openAlexId: null,
            abstract: null,
            signals: {
              venueKnown: false,
              venueInDoaj: null,
              venueIsOa: null,
              venueMeanCitedness: null,
              venueHIndex: null,
              venueApcUsd: null,
              fwci: null,
              citedByPercentileYear: null,
              citedByCount: null,
              isParatext: null,
            },
          });
        }
      }

      return found;
    },
  };
}
