/**
 * OpenAlex client tests — mocked at the transport seam (ARCHITECTURE.md §14).
 *
 * Enrichment is two passes: `/works` for the record, then `/sources` for venue
 * standing, because the source embedded in a work is dehydrated and carries no
 * `summary_stats`. The transport mock therefore dispatches on path — a mock
 * that answered both calls identically was what let the missing second pass go
 * unnoticed until a live run.
 */
import { describe, expect, it, vi } from 'vitest';
import { LiteratureError } from '../../types/errors';
import type { HttpTransport } from './client.types';
import { ENRICH_CHUNK_SIZE, createOpenAlexClient } from './openalex';
import { approveQuery, type ApprovedQuery } from './query';
import { fromInvertedIndex } from './openalex.schemas';

const FAST_LIMIT = {
  'Content-Type': 'application/json',
  'X-Rate-Limit-Limit': '1000',
  'X-Rate-Limit-Interval': '1s',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: FAST_LIMIT });

const SOURCE_ID = 'https://openalex.org/S137773608';

const work = {
  id: 'https://openalex.org/W123',
  doi: 'https://doi.org/10.1000/Example',
  cited_by_count: 412,
  fwci: 3.2,
  is_paratext: false,
  cited_by_percentile_year: { min: 98 },
  abstract_inverted_index: { We: [0], report: [1], reduced: [2], 'off-target': [3] },
  primary_location: { source: { id: SOURCE_ID, is_in_doaj: false, is_oa: false } },
};

const fullSource = {
  id: SOURCE_ID,
  apc_usd: 11390,
  summary_stats: { '2yr_mean_citedness': 42.1, h_index: 1200 },
};

/** Routes `/works` and `/sources` to separate bodies, as the real API does. */
const routed = (works: unknown[], sources: unknown[] = [fullSource]): HttpTransport =>
  vi.fn((url: string) =>
    Promise.resolve(
      url.includes('/sources') ? json({ results: sources }) : json({ results: works }),
    ),
  );

describe('createOpenAlexClient — enrich', () => {
  it('combines work-level signals with venue standing from the second pass', async () => {
    const client = createOpenAlexClient({ transport: routed([work]), initialPacingMs: 0 });

    const result = (await client.enrich(['10.1000/example'])).get('10.1000/example');

    expect(result?.openAlexId).toBe('https://openalex.org/W123');
    expect(result?.signals).toMatchObject({
      venueKnown: true,
      venueInDoaj: false,
      // These three come only from /sources; a dehydrated source has none.
      venueMeanCitedness: 42.1,
      venueHIndex: 1200,
      venueApcUsd: 11390,
      fwci: 3.2,
      citedByPercentileYear: 98,
      citedByCount: 412,
    });
  });

  it('backfills an abstract from the inverted index', async () => {
    // Only one Crossref record in five carries an abstract, so without this the
    // local re-ranker has little more than titles to embed.
    const client = createOpenAlexClient({ transport: routed([work]), initialPacingMs: 0 });

    expect((await client.enrich(['10.1000/example'])).get('10.1000/example')?.abstract).toBe(
      'We report reduced off-target',
    );
  });

  it('reports a null abstract when OpenAlex has none', async () => {
    const bare = { ...work, abstract_inverted_index: null };
    const client = createOpenAlexClient({ transport: routed([bare]), initialPacingMs: 0 });

    expect((await client.enrich(['10.1000/example'])).get('10.1000/example')?.abstract).toBeNull();
  });

  it('asks /sources for the venues a page references', async () => {
    const transport = routed([work]);
    await createOpenAlexClient({ transport, initialPacingMs: 0 }).enrich(['10.1000/example']);

    const paths = vi.mocked(transport).mock.calls.map((call) => call[0]);
    expect(paths.some((path) => path.includes('/works?filter=doi:'))).toBe(true);
    // The bare key, not the URL form, is what the ids.openalex filter accepts.
    expect(paths.some((path) => path.includes('ids.openalex:S137773608'))).toBe(true);
  });

  it('leaves standing null when the venue is absent from the sources response', async () => {
    const client = createOpenAlexClient({ transport: routed([work], []), initialPacingMs: 0 });

    const signals = (await client.enrich(['10.1000/example'])).get('10.1000/example')?.signals;
    expect(signals?.venueKnown).toBe(true);
    expect(signals?.venueMeanCitedness).toBeNull();
  });

  it('skips the second pass entirely when no work names a venue', async () => {
    const transport = routed([{ ...work, primary_location: null }]);
    await createOpenAlexClient({ transport, initialPacingMs: 0 }).enrich(['10.1000/example']);

    expect(vi.mocked(transport).mock.calls.every((call) => !call[0].includes('/sources'))).toBe(
      true,
    );
  });

  it('normalises OpenAlex DOI URLs to the bare lowercase identifier', async () => {
    const client = createOpenAlexClient({ transport: routed([work]), initialPacingMs: 0 });
    expect([...(await client.enrich(['10.1000/example'])).keys()]).toEqual(['10.1000/example']);
  });

  it('reports a DOI OpenAlex does not know as checked-and-absent, not missing', async () => {
    const client = createOpenAlexClient({ transport: routed([]), initialPacingMs: 0 });

    const result = (await client.enrich(['10.1000/unknown'])).get('10.1000/unknown');

    expect(result).toBeDefined();
    expect(result?.signals.venueKnown).toBe(false);
    expect(result?.signals.venueMeanCitedness).toBeNull();
  });

  it('reports a work with no venue as venue-unknown rather than throwing', async () => {
    const client = createOpenAlexClient({
      transport: routed([{ ...work, primary_location: null }]),
    });

    expect(
      (await client.enrich(['10.1000/example'])).get('10.1000/example')?.signals,
    ).toMatchObject({
      venueKnown: false,
      venueInDoaj: null,
    });
  });

  it('never reads is_retracted, which ADR-029 rejects as an authority', async () => {
    const client = createOpenAlexClient({ transport: routed([{ ...work, is_retracted: true }]) });

    const signals = (await client.enrich(['10.1000/example'])).get('10.1000/example')?.signals;
    expect(JSON.stringify(signals)).not.toContain('retract');
  });

  it('batches DOIs into OR-filtered requests', async () => {
    const transport = routed([]);
    const client = createOpenAlexClient({ transport, initialPacingMs: 0 });

    const dois = Array.from({ length: ENRICH_CHUNK_SIZE + 1 }, (_, i) => `10.1/${String(i)}`);
    await client.enrich(dois);

    const workCalls = vi.mocked(transport).mock.calls.filter((call) => call[0].includes('/works'));
    expect(workCalls).toHaveLength(2);
  });

  it('returns every requested DOI across batches', async () => {
    const client = createOpenAlexClient({ transport: routed([]), initialPacingMs: 0 });

    const dois = Array.from({ length: ENRICH_CHUNK_SIZE + 3 }, (_, i) => `10.1/${String(i)}`);
    expect((await client.enrich(dois)).size).toBe(dois.length);
  });

  it('does nothing and issues no request for an empty list', async () => {
    const transport = routed([]);
    const client = createOpenAlexClient({ transport, initialPacingMs: 0 });

    expect((await client.enrich([])).size).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it('leaves a batch unenriched on a malformed payload rather than asserting absence', async () => {
    const transport: HttpTransport = vi.fn(() => Promise.resolve(json({ unexpected: true })));
    const client = createOpenAlexClient({ transport, initialPacingMs: 0 });

    expect((await client.enrich(['10.1/a'])).size).toBe(0);
  });

  it('raises rather than reporting absent standing when the sources pass fails', async () => {
    // Silently degrading here would print "no venue citedness" for a journal
    // that was never looked up — the confusion ADR-029 exists to prevent.
    const transport: HttpTransport = vi.fn((url: string) =>
      url.includes('/sources')
        ? Promise.reject(new TypeError('network'))
        : Promise.resolve(json({ results: [work] })),
    );
    const client = createOpenAlexClient({ transport, initialPacingMs: 0 });

    await expect(client.enrich(['10.1000/example'])).rejects.toBeInstanceOf(LiteratureError);
  });

  it('raises a typed error when the transport fails', async () => {
    const transport: HttpTransport = vi.fn(() => Promise.reject(new TypeError('network')));
    const client = createOpenAlexClient({ transport, initialPacingMs: 0 });

    await expect(client.enrich(['10.1/a'])).rejects.toBeInstanceOf(LiteratureError);
  });

  it('sends no User-Agent, which browsers forbid', async () => {
    const transport = routed([]);
    await createOpenAlexClient({ transport, initialPacingMs: 0 }).enrich(['10.1/a']);

    const headers = vi.mocked(transport).mock.calls[0]?.[1].headers ?? {};
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('user-agent');
  });

  it('sends the API key, which replaced the retired mailto pool', async () => {
    // OpenAlex dropped `mailto` in February 2026. Without a key a caller gets a
    // trial allowance and then 429s, which reads as a search finding nothing.
    const transport = routed([]);
    await createOpenAlexClient({ transport, apiKey: 'k-123', initialPacingMs: 0 }).enrich([
      '10.1/a',
    ]);

    const url = vi.mocked(transport).mock.calls[0]?.[0] ?? '';
    expect(url).toContain('api_key=k-123');
    expect(url).not.toContain('mailto');
  });

  it('still works unkeyed, on the small allowance OpenAlex permits', async () => {
    const transport = routed([]);
    await createOpenAlexClient({ transport, initialPacingMs: 0 }).enrich(['10.1/a']);

    expect(vi.mocked(transport).mock.calls[0]?.[0]).not.toContain('api_key');
  });

  it('explains the rate limit in terms of the missing key', async () => {
    const transport: HttpTransport = vi.fn(() =>
      Promise.resolve(new Response('', { status: 429, headers: { 'Retry-After': '0' } })),
    );
    await expect(
      createOpenAlexClient({ transport, initialPacingMs: 0 }).enrich(['10.1/a']),
    ).rejects.toThrow(/API key/iu);
  });
});

describe('fromInvertedIndex', () => {
  it('restores word order from positions', () => {
    expect(fromInvertedIndex({ quick: [1], The: [0], fox: [2] })).toBe('The quick fox');
  });

  it('repeats a word at each position it claims', () => {
    expect(fromInvertedIndex({ the: [0, 2], very: [1], end: [3] })).toBe('the very the end');
  });

  it('drops holes rather than filling them with a placeholder', () => {
    // The result is fed to an embedding model, not read aloud.
    expect(fromInvertedIndex({ start: [0], end: [3] })).toBe('start end');
  });

  it('returns null for absent or empty input', () => {
    expect(fromInvertedIndex(null)).toBeNull();
    expect(fromInvertedIndex(undefined)).toBeNull();
    expect(fromInvertedIndex({})).toBeNull();
  });

  it('ignores negative or non-integer positions', () => {
    expect(fromInvertedIndex({ ok: [0], bad: [-1] })).toBe('ok');
  });
});

describe('createOpenAlexClient — search', () => {
  const query = (text = 'AlphaFold3 protein structure prediction'): ApprovedQuery => {
    const approval = approveQuery(text);
    if (!approval.ok) throw new Error('test query rejected');
    return approval.query;
  };

  const searchWork = {
    id: 'https://openalex.org/W456',
    doi: 'https://doi.org/10.1038/s41586-024-07487-w',
    display_name: 'Accurate structure prediction of biomolecular interactions with AlphaFold 3',
    publication_year: 2024,
    type: 'article',
    authorships: [{ author: { display_name: 'Josh Abramson' } }],
    abstract_inverted_index: { We: [0], present: [1] },
    primary_location: {
      source: { id: SOURCE_ID, display_name: 'Nature', is_in_doaj: false, is_oa: false },
      landing_page_url: 'https://www.nature.com/articles/s41586-024-07487-w',
    },
  };

  const searching = (results: unknown[]): HttpTransport =>
    vi.fn(() => Promise.resolve(json({ results })));

  it('maps a work into the domain record', async () => {
    const client = createOpenAlexClient({ transport: searching([searchWork]), initialPacingMs: 0 });
    const [record] = await client.search(query(), 10, null);

    expect(record?.title).toContain('AlphaFold 3');
    expect(record?.containerTitle).toBe('Nature');
    expect(record?.issued).toEqual({ year: 2024, month: null, day: null });
    expect(record?.doi).toBe('10.1038/s41586-024-07487-w');
    expect(record?.discoveredVia).toBe('openalex');
    expect(record?.abstract).toBe('We present');
  });

  it('bounds by year when a filter is set, and not otherwise', async () => {
    const bounded = searching([]);
    await createOpenAlexClient({ transport: bounded, initialPacingMs: 0 }).search(
      query(),
      10,
      2022,
    );
    expect(vi.mocked(bounded).mock.calls[0]?.[0]).toContain('from_publication_date:2022-01-01');

    const unbounded = searching([]);
    await createOpenAlexClient({ transport: unbounded, initialPacingMs: 0 }).search(
      query(),
      10,
      null,
    );
    expect(vi.mocked(unbounded).mock.calls[0]?.[0]).not.toContain('from_publication_date');
  });

  it('drops a work with no title rather than showing an unusable row', async () => {
    const client = createOpenAlexClient({
      transport: searching([{ id: 'https://openalex.org/W1' }, searchWork]),
    });
    expect(await client.search(query(), 10, null)).toHaveLength(1);
  });

  it('returns an empty list for a malformed payload rather than throwing', async () => {
    const transport: HttpTransport = vi.fn(() => Promise.resolve(json({ unexpected: true })));
    expect(
      await createOpenAlexClient({ transport, initialPacingMs: 0 }).search(query(), 10, null),
    ).toEqual([]);
  });
});
