/**
 * PubMed client over NCBI E-utilities (DECISIONS.md ADR-028, ADR-029).
 *
 * Two calls per search, because NCBI splits them: `esearch` returns PMIDs as
 * JSON, `efetch` returns the records as XML. Parsing lives in
 * `pubmed.schemas.ts`; this file owns transport, pacing, and errors.
 *
 * NCBI is stricter than the other sources and enforces its limits by blocking,
 * so the conservative default pace in `etiquette.ts` matters more here than
 * anywhere else: unlike Crossref, NCBI does not advertise its limit in response
 * headers, so there is nothing to learn from and the fallback pace is what
 * actually governs. A `tool` and `email` parameter is sent when configured,
 * which is what NCBI asks of clients and what lets an operator contact a user
 * rather than simply blocking them.
 */
import { LiteratureError } from '../../types/errors';
import type { LiteratureRecord } from '../../types/literature';
import type { HttpTransport, LiteratureClientConfig, LiteratureSearchClient } from './client.types';
import { backoffMs, minIntervalMs, parseRateLimit } from './etiquette';
import { queryText, type ApprovedQuery } from './query';
import { parseArticleSet, parsePmidList, type PubMedArticle } from './pubmed.schemas';

const DEFAULT_BASE_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

/** Identifies the caller to NCBI, which asks every client to name itself. */
const TOOL_NAME = 'gretta';

const defaultTransport: HttpTransport = (url, init) => fetch(url, init);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A PubMed search result: records plus the MEDLINE status per PMID. */
export interface PubMedSearchResult {
  records: LiteratureRecord[];
  /** PMID → MEDLINE-indexed. A curation decision, not mere presence. */
  medlineIndexed: Map<string, boolean>;
}

export interface PubMedClient extends LiteratureSearchClient {
  /** Search returning the MEDLINE signal alongside the records. */
  searchDetailed(
    query: ApprovedQuery,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PubMedSearchResult>;
}

export function createPubMedClient(config: LiteratureClientConfig = {}): PubMedClient {
  const transport = config.transport ?? defaultTransport;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const contactEmail = config.contactEmail ?? null;

  let pacingMs = config.initialPacingMs ?? minIntervalMs(null);
  let lastRequestAt = 0;

  function identify(path: string): string {
    const separator = path.includes('?') ? '&' : '?';
    const email = contactEmail?.trim() ?? '';
    const contact = email === '' ? '' : `&email=${encodeURIComponent(email)}`;
    return `${baseUrl}${path}${separator}tool=${TOOL_NAME}${contact}`;
  }

  async function request(path: string, signal?: AbortSignal): Promise<string> {
    const url = identify(path);

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
        // No headers at all: this is a simple cross-origin GET, which is what
        // keeps it free of a preflight NCBI would not answer.
        response = await transport(url, { method: 'GET', signal: controller.signal });
      } catch (cause) {
        if (signal?.aborted === true) throw cause;
        throw new LiteratureError('offline', 'pubmed', 'Could not reach PubMed.', { cause });
      } finally {
        clearTimeout(timer);
        lastRequestAt = Date.now();
        signal?.removeEventListener('abort', onAbort);
      }

      // NCBI does not advertise a limit, so this almost always keeps the
      // conservative fallback pace — which is the intent.
      pacingMs = minIntervalMs(parseRateLimit(response.headers));

      if (response.status === 429 || response.status >= 500) {
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new LiteratureError(
            response.status === 429 ? 'rate-limited' : 'http',
            'pubmed',
            `PubMed is rate-limiting or unavailable (HTTP ${String(response.status)}).`,
            { code: String(response.status) },
          );
        }
        await sleep(backoffMs(attempt, response.headers.get('Retry-After')));
        continue;
      }

      if (!response.ok) {
        throw new LiteratureError(
          'http',
          'pubmed',
          `PubMed returned HTTP ${String(response.status)}.`,
          { code: String(response.status) },
        );
      }

      try {
        return await response.text();
      } catch (cause) {
        throw new LiteratureError(
          'invalid-response',
          'pubmed',
          'PubMed returned a response that could not be read.',
          { cause },
        );
      }
    }

    throw new LiteratureError('http', 'pubmed', 'PubMed did not respond successfully.');
  }

  async function findIds(term: string, retmax: number, signal?: AbortSignal): Promise<string[]> {
    const path =
      `/esearch.fcgi?db=pubmed&retmode=json&sort=relevance` +
      `&retmax=${String(retmax)}&term=${encodeURIComponent(term)}`;
    try {
      return parsePmidList(JSON.parse(await request(path, signal)));
    } catch (cause) {
      if (cause instanceof LiteratureError) throw cause;
      throw new LiteratureError(
        'invalid-response',
        'pubmed',
        'PubMed returned a search response that could not be read as JSON.',
        { cause },
      );
    }
  }

  async function fetchArticles(
    query: ApprovedQuery,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PubMedArticle[]> {
    const retmax = Math.max(1, Math.min(limit, 100));
    const term = queryText(query);

    /*
     * Progressive relaxation, because PubMed's Automatic Term Mapping ANDs
     * every term it is given. A twelve-keyword query derived from a passage
     * therefore asks for one paper containing all twelve, and returns nothing —
     * which is exactly what happened with PubMed enabled alone, while Crossref
     * (a scored relevance match) returned results for the same string. Same
     * query, opposite semantics.
     *
     * The strict form is tried first because when it does match, it matches
     * well. Only when it comes back empty are the terms OR'd, which hands the
     * ranking to PubMed's Best Match model rather than to a conjunction no
     * paper can satisfy.
     */
    let ids = await findIds(term, retmax, signal);

    if (ids.length === 0) {
      const terms = term.split(/[\s,]+/u).filter((token) => token.length > 1);
      if (terms.length > 1) {
        ids = await findIds(terms.join(' OR '), retmax, signal);
      }
    }

    if (ids.length === 0) return [];

    const xml = await request(
      `/efetch.fcgi?db=pubmed&retmode=xml&id=${ids.map(encodeURIComponent).join(',')}`,
      signal,
    );
    return parseArticleSet(xml);
  }

  return {
    id: 'pubmed',

    async search(
      query: ApprovedQuery,
      limit: number,
      signal?: AbortSignal,
    ): Promise<LiteratureRecord[]> {
      return (await fetchArticles(query, limit, signal)).map((article) => article.record);
    },

    async searchDetailed(
      query: ApprovedQuery,
      limit: number,
      signal?: AbortSignal,
    ): Promise<PubMedSearchResult> {
      const articles = await fetchArticles(query, limit, signal);
      const medlineIndexed = new Map<string, boolean>();
      for (const article of articles) {
        const pmid = article.record.pmid;
        if (pmid !== null) medlineIndexed.set(pmid, article.medlineIndexed);
      }
      return { records: articles.map((article) => article.record), medlineIndexed };
    },
  };
}
