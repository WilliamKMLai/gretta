/**
 * Crossref client (DECISIONS.md ADR-028, ADR-029).
 *
 * Two jobs. It searches Crossref's 180-million-record index, and — the reason
 * it was built first — it is the authority for post-publication updates.
 * ADR-029 rejects OpenAlex's `is_retracted` boolean because it collapses
 * distinct notice types into one flag, a collapse that has already mislabelled
 * a corrected paper as retracted. Crossref's `update-to` preserves both the
 * type of the notice and whether a publisher or Retraction Watch supplied it,
 * which is exactly what a warning needs to be trustworthy.
 *
 * Every failure leaves as a typed `LiteratureError`. Unlike `KbError`, an
 * `offline` here is not routinely benign: the user asked for a search and did
 * not get one, so it surfaces rather than being swallowed.
 */
import { LiteratureError } from '../../types/errors';
import type { LiteratureRecord, UpdateStatus, WorkUpdate } from '../../types/literature';
import type {
  HttpTransport,
  LiteratureClientConfig,
  LiteratureSearchClient,
  UpdateLookupClient,
} from './client.types';
import {
  abortableSleep,
  backoffMs,
  minIntervalMs,
  parseRateLimit,
  throwIfAborted,
  withContact,
} from './etiquette';
import { abstractToText, firstNonEmpty } from './jats';
import { queryText, type ApprovedQuery } from './query';
import {
  parseNoticeList,
  parseWorkList,
  toIsoDate,
  toUpdateType,
  toWorkType,
  type CrossrefWork,
} from './schemas';

/**
 * Identification is by query parameter, never by `User-Agent`.
 *
 * `User-Agent` is a forbidden header name in browsers: the fetch spec has the
 * user agent control it, and an attempt to set one is refused. GRETTA runs in a
 * Word task pane, so setting it failed every request in the webview while
 * working perfectly under Node — which is exactly what the live smoke tests run
 * on, so they could not catch it. Crossref's own etiquette guidance points
 * browser clients at the `mailto` parameter for this reason, and NCBI at `tool`
 * and `email`; both are query parameters, both survive.
 */

const DEFAULT_BASE_URL = 'https://api.crossref.org';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

/**
 * DOIs per update lookup.
 *
 * Measured against the live API, a `filter=updates:` query costs roughly a
 * second whether or not it matches anything — checking ten results one at a
 * time took twelve seconds. That rules out lazy checking, and for a design
 * reason rather than a performance one: ADR-029 requires a retraction warning
 * to be exempt from every filter and visible even on a top-ranked result, and a
 * warning that only appears when a result is opened is one the user can miss by
 * not opening it. So the check must complete before the list paints, which
 * means it must be batched.
 *
 * Batching is safe here only because the query runs in the reverse direction
 * (notices that update a DOI, rather than a DOI's own record). The request
 * enumerates the DOIs asked about and notices are attributed back through
 * `update-to`, so "checked, nothing found" survives — it would not have with a
 * forward query, where an omitted result is indistinguishable from an
 * unchecked one.
 */
export const UPDATE_CHUNK_SIZE = 20;

/**
 * DOI prefixes for bioRxiv and medRxiv, which share both.
 *
 * `10.1101` covers everything posted while Cold Spring Harbor Laboratory ran
 * the servers; openRxiv took over and began issuing `10.64898` on 1 December
 * 2025. Both are needed — filtering on the newer prefix alone would hide every
 * preprint older than that, and on the older alone would hide everything since.
 *
 * The two servers cannot be told apart by prefix, so results are separated
 * afterwards by the server name Crossref carries in the record.
 */
const OPENRXIV_PREFIXES = ['10.1101', '10.64898'] as const;

/** Which preprint server a caller wants, since the DOI prefix cannot say. */
export type PreprintServer = 'biorxiv' | 'medrxiv';

const SERVER_PATTERNS: Readonly<Record<PreprintServer, RegExp>> = {
  biorxiv: /biorxiv/iu,
  medrxiv: /medrxiv/iu,
};

/** Local copy; the six-line generic is not worth a shared module. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

const defaultTransport: HttpTransport = (url, init) => fetch(url, init);

/** Only the two fields a contributor needs; CSL wants family/given separately. */
function toContributors(work: CrossrefWork): LiteratureRecord['authors'] {
  return (work.author ?? []).map((author) => ({
    // A consortium deposits `name` with no family/given; keeping it in `family`
    // is what CSL expects for a literal name.
    family: author.family ?? author.name ?? '',
    given: author.given ?? null,
  }));
}

function toIssued(work: CrossrefWork): LiteratureRecord['issued'] {
  const parts = work.issued?.['date-parts']?.[0];
  const year = parts?.[0];
  // Undated works arrive as [[null]]; they are still citable, just undated.
  if (typeof year !== 'number') return null;
  return {
    year,
    month: typeof parts?.[1] === 'number' ? parts[1] : null,
    day: typeof parts?.[2] === 'number' ? parts[2] : null,
  };
}

function toRecord(work: CrossrefWork): LiteratureRecord | null {
  const doi = work.DOI ?? null;
  const title = firstNonEmpty(work.title);
  // A record with neither a title nor a DOI cannot be displayed or cited, so it
  // is dropped rather than shown as an untitled row the user cannot act on.
  if (title === null || doi === null) return null;

  return {
    id: `crossref:${doi}`,
    doi,
    pmid: null,
    arxivId: null,
    openAlexId: null,
    title,
    authors: toContributors(work),
    containerTitle: firstNonEmpty(work['container-title']),
    issued: toIssued(work),
    abstract: abstractToText(work.abstract),
    type: toWorkType(work.type),
    url: work.URL ?? `https://doi.org/${doi}`,
    discoveredVia: 'crossref',
  };
}

/**
 * Collects the notices that update `doi`.
 *
 * The direction here is the whole point, and getting it backwards is why the
 * first live run reported the Wakefield MMR paper as carrying no updates at
 * all. Crossref records `update-to` on the **retraction notice**, pointing back
 * at the work it retracts — not on the retracted work. Asking a paper's own
 * record whether it has been retracted therefore always answers no, and answers
 * it with `checked: true`, which is worse than not checking: it is a confident
 * all-clear on a retracted paper. Notices are found with `filter=updates:{doi}`
 * and their `update-to` entries are matched back to the DOI that was asked
 * about.
 */
function toUpdatesFor(doi: string, notices: readonly CrossrefWork[]): WorkUpdate[] {
  const target = doi.trim().toLowerCase();
  const updates: WorkUpdate[] = [];

  for (const notice of notices) {
    for (const entry of notice['update-to'] ?? []) {
      if ((entry.DOI ?? '').trim().toLowerCase() !== target) continue;
      updates.push({
        type: toUpdateType(entry.type),
        source: entry.source ?? 'unknown',
        // The DOI of the notice itself, so the user can read it rather than a
        // summary of it; `entry.DOI` is the retracted work, not the notice.
        noticeDoi: notice.DOI ?? null,
        // The notice's own words. ADR-029 forbids paraphrasing a retraction.
        label: entry.label ?? entry.type ?? 'Post-publication update',
        date: toIsoDate(entry.updated),
      });
    }
  }

  return updates;
}

/** Crossref does three jobs: search, preprint-server search, and verification. */
export interface CrossrefClient extends LiteratureSearchClient, UpdateLookupClient {
  searchPreprints(
    query: ApprovedQuery,
    limit: number,
    server: PreprintServer,
    signal?: AbortSignal,
  ): Promise<LiteratureRecord[]>;
}

export function createCrossrefClient(config: LiteratureClientConfig = {}): CrossrefClient {
  const transport = config.transport ?? defaultTransport;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const contactEmail = config.contactEmail ?? null;

  /** Pace learned from the server's own advertised limit, not from a constant. */
  let pacingMs = config.initialPacingMs ?? minIntervalMs(null);
  let lastRequestAt = 0;

  async function request(path: string, signal?: AbortSignal): Promise<unknown> {
    const url = withContact(`${baseUrl}${path}`, contactEmail);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      const elapsed = Date.now() - lastRequestAt;
      if (elapsed < pacingMs) await abortableSleep(pacingMs - elapsed, signal);

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
          // `Accept` is CORS-safelisted, so this stays a simple request with no
          // preflight. See the note above on why no `User-Agent` is sent.
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
      } catch (cause) {
        if (signal?.aborted === true) throw cause; // caller cancelled — pass through
        throw new LiteratureError('offline', 'crossref', 'Could not reach Crossref.', { cause });
      } finally {
        clearTimeout(timer);
        lastRequestAt = Date.now();
        signal?.removeEventListener('abort', onAbort);
      }

      // Adopt the server's advertised pace for every subsequent request.
      pacingMs = minIntervalMs(parseRateLimit(response.headers));

      if (response.status === 429 || response.status >= 500) {
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new LiteratureError(
            response.status === 429 ? 'rate-limited' : 'http',
            'crossref',
            `Crossref is rate-limiting or unavailable (HTTP ${String(response.status)}).`,
            { code: String(response.status) },
          );
        }
        await abortableSleep(backoffMs(attempt, response.headers.get('Retry-After')), signal);
        continue;
      }

      if (!response.ok) {
        throw new LiteratureError(
          'http',
          'crossref',
          `Crossref returned HTTP ${String(response.status)}.`,
          { code: String(response.status) },
        );
      }

      try {
        return await response.json();
      } catch (cause) {
        throw new LiteratureError(
          'invalid-response',
          'crossref',
          'Crossref returned a response that could not be read as JSON.',
          { cause },
        );
      }
    }

    throw new LiteratureError('http', 'crossref', 'Crossref did not respond successfully.');
  }

  return {
    id: 'crossref',

    async search(
      query: ApprovedQuery,
      limit: number,
      signal?: AbortSignal,
    ): Promise<LiteratureRecord[]> {
      const rows = Math.max(1, Math.min(limit, 100));
      // `query=` is Crossref's general keyword search. `query.bibliographic=`
      // is for matching a full citation string and behaves erratically on loose
      // keywords, which is not what a user types into a search box.
      const path =
        `/works?query=${encodeURIComponent(queryText(query))}` +
        `&rows=${String(rows)}&select=DOI,title,author,container-title,issued,abstract,type,URL,member`;
      const payload = await request(path, signal);
      return parseWorkList(payload)
        .map(toRecord)
        .filter((record): record is LiteratureRecord => record !== null);
    },

    /**
     * Keyword search restricted to a preprint server.
     *
     * bioRxiv and medRxiv publish no keyword search API of their own — theirs
     * serves details by DOI and listings by date — but both deposit into
     * Crossref, which does have one. Filtering by DOI prefix and posted-content
     * type narrows the index to preprints, and the server name in the record
     * separates the two. Note that arXiv is *not* reachable this way: DataCite
     * registers its DOIs, so Crossref does not index it.
     */
    async searchPreprints(
      query: ApprovedQuery,
      limit: number,
      server: PreprintServer,
      signal?: AbortSignal,
    ): Promise<LiteratureRecord[]> {
      const rows = Math.max(1, Math.min(limit, 100));
      const poolRows = Math.min(rows * 2, 100);
      const prefixes = OPENRXIV_PREFIXES.map((prefix) => `prefix:${prefix}`).join(',');
      const path =
        `/works?query=${encodeURIComponent(queryText(query))}` +
        `&filter=type:posted-content,${prefixes}&rows=${String(poolRows)}` +
        `&select=DOI,title,author,container-title,issued,abstract,type,URL,member,institution,group-title`;

      const works = parseWorkList(await request(path, signal));
      const pattern = SERVER_PATTERNS[server];

      return works
        .filter((work) => {
          // Crossref carries the server in `institution` or `group-title`
          // depending on how the deposit was made; either identifies it.
          const names = [
            ...(work.institution ?? []).map((entry) => entry.name ?? ''),
            work['group-title'] ?? '',
          ];
          return names.some((name) => pattern.test(name));
        })
        .map(toRecord)
        .filter((record): record is LiteratureRecord => record !== null)
        .slice(0, rows)
        .map((record) => ({ ...record, type: 'preprint' as const, discoveredVia: server }));
    },

    async lookupUpdates(
      dois: readonly string[],
      signal?: AbortSignal,
    ): Promise<Map<string, UpdateStatus>> {
      const results = new Map<string, UpdateStatus>();
      if (dois.length === 0) return results;

      for (const batch of chunk(dois, UPDATE_CHUNK_SIZE)) {
        // Repeating a filter name ORs its values in Crossref's query syntax.
        // Each DOI is percent-encoded, so a comma inside one cannot be mistaken
        // for the separator between them.
        const filter = batch.map((doi) => `updates:${encodeURIComponent(doi)}`).join(',');

        try {
          const payload = await request(`/works?filter=${filter}&rows=100`, signal);
          const notices = parseNoticeList(payload);
          if (notices === null) {
            for (const doi of batch) results.set(doi, { checked: false, updates: [] });
            continue;
          }
          for (const doi of batch) {
            results.set(doi, { checked: true, updates: toUpdatesFor(doi, notices) });
          }
        } catch (error) {
          if (signal?.aborted === true) throw error;
          // A failed lookup is explicitly NOT an all-clear (ADR-029). The whole
          // batch is marked unchecked, since one failed request tells us nothing
          // about any DOI in it.
          for (const doi of batch) results.set(doi, { checked: false, updates: [] });
        }
      }

      return results;
    },
  };
}
