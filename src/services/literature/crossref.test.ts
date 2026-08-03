/**
 * Crossref client tests — mocked at the transport seam (ARCHITECTURE.md §14),
 * so no network is involved. `client.test.ts` in `services/knowledgebase` is
 * the pattern being followed.
 *
 * Every response carries a generous advertised rate limit so the client's own
 * pacing does not slow the suite; the pacing behaviour itself is covered in
 * `etiquette.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { LiteratureError } from '../../types/errors';
import type { HttpTransport } from './client.types';
import { UPDATE_CHUNK_SIZE, createCrossrefClient } from './crossref';
import { approveQuery, type ApprovedQuery } from './query';

const FAST_LIMIT = {
  'Content-Type': 'application/json',
  'X-Rate-Limit-Limit': '1000',
  'X-Rate-Limit-Interval': '1s',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: FAST_LIMIT });

const query = (text = 'base editing hepatocyte'): ApprovedQuery => {
  const approval = approveQuery(text);
  if (!approval.ok) throw new Error('test query rejected');
  return approval.query;
};

const work = {
  DOI: '10.1000/example',
  title: ['<jats:italic>Base</jats:italic> editing in hepatocytes'],
  author: [{ family: 'Doe', given: 'Jane' }, { name: 'The Consortium' }],
  'container-title': ['Nature'],
  issued: { 'date-parts': [[2024, 5, 12]] },
  abstract: '<jats:p>We report reduced off-target effects.</jats:p>',
  type: 'journal-article',
  URL: 'https://doi.org/10.1000/example',
};

describe('createCrossrefClient — search', () => {
  it('maps a work into a CSL-shaped record with markup stripped', async () => {
    const transport: HttpTransport = vi.fn(() =>
      Promise.resolve(json({ message: { items: [work] } })),
    );
    const client = createCrossrefClient({ transport, initialPacingMs: 0 });

    const [record] = await client.search(query(), 10);

    expect(record?.title).toBe('Base editing in hepatocytes');
    expect(record?.abstract).toBe('We report reduced off-target effects.');
    expect(record?.containerTitle).toBe('Nature');
    expect(record?.issued).toEqual({ year: 2024, month: 5, day: 12 });
    expect(record?.type).toBe('article');
    expect(record?.discoveredVia).toBe('crossref');
  });

  it('keeps a corporate author as a literal name, which is what CSL expects', async () => {
    const transport: HttpTransport = vi.fn(() =>
      Promise.resolve(json({ message: { items: [work] } })),
    );
    const client = createCrossrefClient({ transport, initialPacingMs: 0 });

    const [record] = await client.search(query(), 10);

    expect(record?.authors[1]).toEqual({ family: 'The Consortium', given: null });
  });

  it('labels posted-content as a preprint rather than demoting it', async () => {
    const preprint = { ...work, type: 'posted-content' };
    const transport: HttpTransport = vi.fn(() =>
      Promise.resolve(json({ message: { items: [preprint] } })),
    );
    const client = createCrossrefClient({ transport, initialPacingMs: 0 });

    expect((await client.search(query(), 10))[0]?.type).toBe('preprint');
  });

  it('drops records with no title or DOI instead of showing unusable rows', async () => {
    const transport: HttpTransport = vi.fn(() =>
      Promise.resolve(
        json({ message: { items: [{ DOI: '10.1/x' }, { title: ['No DOI'] }, work] } }),
      ),
    );
    const client = createCrossrefClient({ transport, initialPacingMs: 0 });

    expect(await client.search(query(), 10)).toHaveLength(1);
  });

  it('keeps other records when one on the page is malformed', async () => {
    // Crossref emits [[null]] date-parts for undated works. Validating the page
    // as a unit meant one such record emptied an entire search.
    const undated = { DOI: '10.1/undated', title: ['No date'], issued: { 'date-parts': [[null]] } };
    const transport: HttpTransport = vi.fn(() =>
      Promise.resolve(json({ message: { items: [undated, work] } })),
    );
    const records = await createCrossrefClient({
      transport,
      initialPacingMs: 0,
    }).search(query(), 10);

    expect(records).toHaveLength(2);
    expect(records.find((record) => record.doi === '10.1/undated')?.issued).toBeNull();
  });

  it('uses the general keyword search, not bibliographic citation matching', async () => {
    const transport: HttpTransport = vi.fn(() => Promise.resolve(json({ message: { items: [] } })));
    await createCrossrefClient({ transport, initialPacingMs: 0 }).search(query('crispr'), 5);

    expect(vi.mocked(transport).mock.calls[0]?.[0]).toContain('/works?query=');
    expect(vi.mocked(transport).mock.calls[0]?.[0]).not.toContain('query.bibliographic');
  });

  it('sends the approved query and no other user text', async () => {
    const transport: HttpTransport = vi.fn(() => Promise.resolve(json({ message: { items: [] } })));
    const client = createCrossrefClient({ transport, initialPacingMs: 0 });

    await client.search(query('crispr off-target'), 10);

    const url = vi.mocked(transport).mock.calls[0]?.[0] ?? '';
    expect(url).toContain('crispr%20off-target');
  });

  it('sends no User-Agent, which browsers forbid and Word therefore refused', async () => {
    // Set under Node, this passed every live smoke test and failed every real
    // request in the task pane. Identification is by query parameter instead.
    const transport: HttpTransport = vi.fn(() => Promise.resolve(json({ message: { items: [] } })));
    await createCrossrefClient({ transport, initialPacingMs: 0 }).search(query(), 5);

    const headers = vi.mocked(transport).mock.calls[0]?.[1].headers ?? {};
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('user-agent');
  });

  it('joins the polite pool only when a contact address is configured', async () => {
    const transport: HttpTransport = vi.fn(() => Promise.resolve(json({ message: { items: [] } })));

    await createCrossrefClient({ transport, initialPacingMs: 0 }).search(query(), 5);
    expect(vi.mocked(transport).mock.calls[0]?.[0]).not.toContain('mailto');

    const polite: HttpTransport = vi.fn(() => Promise.resolve(json({ message: { items: [] } })));
    await createCrossrefClient({
      transport: polite,
      contactEmail: 'a@b.org',
      initialPacingMs: 0,
    }).search(query(), 5);
    expect(vi.mocked(polite).mock.calls[0]?.[0]).toContain('mailto=a%40b.org');
  });

  it('returns an empty list for a malformed payload rather than throwing', async () => {
    const transport: HttpTransport = vi.fn(() => Promise.resolve(json({ unexpected: true })));
    const client = createCrossrefClient({ transport, initialPacingMs: 0 });

    expect(await client.search(query(), 10)).toEqual([]);
  });

  it('raises a typed offline error when the transport fails', async () => {
    const transport: HttpTransport = vi.fn(() => Promise.reject(new TypeError('network')));
    const client = createCrossrefClient({ transport, initialPacingMs: 0 });

    await expect(client.search(query(), 10)).rejects.toBeInstanceOf(LiteratureError);
  });

  it('raises rate-limited after exhausting retries on 429', async () => {
    const transport: HttpTransport = vi.fn(() =>
      Promise.resolve(
        new Response('', { status: 429, headers: { ...FAST_LIMIT, 'Retry-After': '0' } }),
      ),
    );
    const client = createCrossrefClient({ transport, initialPacingMs: 0 });

    await expect(client.search(query(), 10)).rejects.toMatchObject({ kind: 'rate-limited' });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('retries a 500 and succeeds on a later attempt', async () => {
    let call = 0;
    const transport: HttpTransport = vi.fn(() => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? new Response('', { status: 500, headers: { ...FAST_LIMIT, 'Retry-After': '0' } })
          : json({ message: { items: [work] } }),
      );
    });
    const client = createCrossrefClient({ transport, initialPacingMs: 0 });

    expect(await client.search(query(), 10)).toHaveLength(1);
  });

  it('does not retry a 404', async () => {
    const transport: HttpTransport = vi.fn(() =>
      Promise.resolve(new Response('', { status: 404, headers: FAST_LIMIT })),
    );
    const client = createCrossrefClient({ transport, initialPacingMs: 0 });

    await expect(client.search(query(), 10)).rejects.toMatchObject({ kind: 'http' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('createCrossrefClient — searchPreprints', () => {
  const preprint = {
    DOI: '10.1101/2024.01.01.123456',
    title: ['A bioRxiv preprint'],
    type: 'posted-content',
    institution: [{ name: 'bioRxiv' }],
  };
  const medPreprint = {
    DOI: '10.64898/2026.01.01.123456',
    title: ['A medRxiv preprint'],
    type: 'posted-content',
    'group-title': 'medRxiv',
  };

  const posted = (items: unknown[]): HttpTransport =>
    vi.fn(() => Promise.resolve(json({ message: { items } })));

  it('filters on both openRxiv DOI prefixes', async () => {
    // 10.1101 is Cold Spring Harbor's; openRxiv began issuing 10.64898 on
    // 1 December 2025. Either alone hides half the corpus.
    const transport = posted([]);
    await createCrossrefClient({
      transport,
      initialPacingMs: 0,
    }).searchPreprints(query(), 10, 'biorxiv');

    const url = decodeURIComponent(vi.mocked(transport).mock.calls[0]?.[0] ?? '');
    expect(url).toContain('prefix:10.1101');
    expect(url).toContain('prefix:10.64898');
    expect(url).toContain('type:posted-content');
  });

  it('separates the two servers, which share a prefix', async () => {
    const client = createCrossrefClient({
      transport: posted([preprint, medPreprint]),
      initialPacingMs: 0,
    });

    const bio = await client.searchPreprints(query(), 10, 'biorxiv');
    expect(bio).toHaveLength(1);
    expect(bio[0]?.title).toContain('bioRxiv');
  });

  it('reads the server name from group-title when institution is absent', async () => {
    const client = createCrossrefClient({
      transport: posted([preprint, medPreprint]),
      initialPacingMs: 0,
    });

    const med = await client.searchPreprints(query(), 10, 'medrxiv');
    expect(med).toHaveLength(1);
    expect(med[0]?.title).toContain('medRxiv');
  });

  it('labels every result a preprint', async () => {
    const client = createCrossrefClient({ transport: posted([preprint]), initialPacingMs: 0 });
    expect((await client.searchPreprints(query(), 10, 'biorxiv'))[0]?.type).toBe('preprint');
  });

  it('drops records naming no recognisable server', async () => {
    const anonymous = { ...preprint, institution: undefined };
    const client = createCrossrefClient({ transport: posted([anonymous]), initialPacingMs: 0 });
    expect(await client.searchPreprints(query(), 10, 'biorxiv')).toEqual([]);
  });
});

describe('createCrossrefClient — lookupUpdates', () => {
  const TARGET = '10.1000/example';

  /**
   * A retraction notice. Crossref records `update-to` on the notice, pointing
   * back at the work it retracts — querying the retracted work's own record
   * always answers "no updates", which is a confident all-clear on a retracted
   * paper.
   */
  const notice = {
    DOI: '10.1000/notice',
    title: ['Retraction notice'],
    type: 'journal-article',
    'update-to': [
      {
        DOI: TARGET,
        type: 'retraction',
        label: 'Retraction: Base editing in hepatocytes',
        source: 'retraction-watch',
        updated: { 'date-parts': [[2025, 3, 1]] },
      },
    ],
  };

  const notices = (items: unknown[]): HttpTransport =>
    vi.fn(() => Promise.resolve(json({ message: { items } })));

  it('queries for notices that update the DOI, not the DOI itself', async () => {
    const transport = notices([]);
    await createCrossrefClient({ transport, initialPacingMs: 0 }).lookupUpdates([TARGET]);

    expect(vi.mocked(transport).mock.calls[0]?.[0]).toContain('filter=updates:');
  });

  it('checks a whole result set in one request', async () => {
    // A second per call, serially, is twelve seconds for ten results — too slow
    // to run before a list paints, and ADR-029 will not let it run later.
    const transport = notices([]);
    await createCrossrefClient({ transport, initialPacingMs: 0 }).lookupUpdates([
      '10.1/a',
      '10.1/b',
      '10.1/c',
    ]);

    expect(transport).toHaveBeenCalledTimes(1);
    const url = vi.mocked(transport).mock.calls[0]?.[0] ?? '';
    expect(url).toContain('updates:10.1%2Fa,updates:10.1%2Fb,updates:10.1%2Fc');
  });

  it('splits oversized sets across requests', async () => {
    const transport = notices([]);
    const dois = Array.from({ length: UPDATE_CHUNK_SIZE + 1 }, (_, i) => `10.1/${String(i)}`);
    await createCrossrefClient({ transport, initialPacingMs: 0 }).lookupUpdates(dois);

    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('attributes each notice to the DOI it names, not to the whole batch', async () => {
    const client = createCrossrefClient({ transport: notices([notice]), initialPacingMs: 0 });

    const result = await client.lookupUpdates([TARGET, '10.1000/innocent']);

    expect(result.get(TARGET)?.updates).toHaveLength(1);
    // The batched request returns one list; every DOI must not inherit it.
    expect(result.get('10.1000/innocent')).toEqual({ checked: true, updates: [] });
  });

  it('marks an entire failed batch unchecked, since it learned nothing', async () => {
    const transport: HttpTransport = vi.fn(() => Promise.reject(new TypeError('network')));
    const client = createCrossrefClient({ transport, initialPacingMs: 0 });

    const result = await client.lookupUpdates(['10.1/a', '10.1/b']);
    expect(result.get('10.1/a')?.checked).toBe(false);
    expect(result.get('10.1/b')?.checked).toBe(false);
  });

  it('issues no request for an empty list', async () => {
    const transport = notices([]);
    expect(
      (
        await createCrossrefClient({
          transport,
          initialPacingMs: 0,
        }).lookupUpdates([])
      ).size,
    ).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it('reports a retraction with its type, source, and own label intact', async () => {
    const client = createCrossrefClient({ transport: notices([notice]), initialPacingMs: 0 });

    const status = (await client.lookupUpdates([TARGET])).get(TARGET);

    expect(status?.checked).toBe(true);
    expect(status?.updates[0]).toMatchObject({
      type: 'retraction',
      source: 'retraction-watch',
      noticeDoi: '10.1000/notice',
      label: 'Retraction: Base editing in hepatocytes',
      date: '2025-03-01',
    });
  });

  it('ignores notice entries that update some other work', async () => {
    const unrelated = {
      ...notice,
      'update-to': [{ DOI: '10.1000/other', type: 'retraction', label: 'Other' }],
    };
    const client = createCrossrefClient({ transport: notices([unrelated]), initialPacingMs: 0 });

    expect((await client.lookupUpdates([TARGET])).get(TARGET)?.updates).toEqual([]);
  });

  it('matches the DOI case-insensitively, as Crossref casing varies', async () => {
    const mixed = {
      ...notice,
      'update-to': [{ ...notice['update-to'][0], DOI: '10.1000/EXAMPLE' }],
    };
    const client = createCrossrefClient({ transport: notices([mixed]), initialPacingMs: 0 });

    expect((await client.lookupUpdates([TARGET])).get(TARGET)?.updates).toHaveLength(1);
  });

  it('does not promote a correction to a retraction', async () => {
    const corrected = {
      ...notice,
      'update-to': [{ DOI: TARGET, type: 'correction', label: 'Correction', source: 'publisher' }],
    };
    const client = createCrossrefClient({ transport: notices([corrected]), initialPacingMs: 0 });

    expect((await client.lookupUpdates([TARGET])).get(TARGET)?.updates[0]?.type).toBe('correction');
  });

  it('maps an unrecognised notice type to other rather than guessing', async () => {
    const odd = {
      ...notice,
      'update-to': [{ DOI: TARGET, type: 'brand_new_notice_type', label: 'Something' }],
    };
    const client = createCrossrefClient({ transport: notices([odd]), initialPacingMs: 0 });

    expect((await client.lookupUpdates([TARGET])).get(TARGET)?.updates[0]?.type).toBe('other');
  });

  it('marks a clean record as checked, so silence can be reported honestly', async () => {
    const client = createCrossrefClient({ transport: notices([]), initialPacingMs: 0 });

    expect((await client.lookupUpdates([TARGET])).get(TARGET)).toEqual({
      checked: true,
      updates: [],
    });
  });

  it('marks a failed lookup as unchecked rather than as an all-clear', async () => {
    const transport: HttpTransport = vi.fn(() => Promise.reject(new TypeError('network')));
    const client = createCrossrefClient({ transport, initialPacingMs: 0 });

    expect((await client.lookupUpdates([TARGET])).get(TARGET)).toEqual({
      checked: false,
      updates: [],
    });
  });

  it('returns an entry for every requested DOI', async () => {
    const client = createCrossrefClient({ transport: notices([]), initialPacingMs: 0 });

    const result = await client.lookupUpdates(['10.1/a', '10.1/b']);
    expect([...result.keys()]).toEqual(['10.1/a', '10.1/b']);
  });
});
