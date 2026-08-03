/**
 * Live API smoke checks — **skipped unless explicitly opted into**.
 *
 *     GRETTA_LIVE_SMOKE=1 pnpm vitest run live.smoke
 *
 * This file runs under `vitest.smoke.config.ts`, which uses the node
 * environment. That matters: under jsdom, `AbortController` comes from jsdom's
 * realm and Node's `fetch` rejects the signal outright. It was originally
 * arranged with a per-file `@vitest-environment` docblock, which worked and
 * then broke the main suite — environment switching inside one run is
 * unreliable under parallelism. Two configs, two environments, no mixing.
 *
 * Every other test in `services/literature` mocks at the transport seam, which
 * is the right default: the suite must be hermetic, and `pnpm check` must never
 * depend on a third party being up. But that leaves a real gap, and this file
 * exists to close it deliberately rather than pretend it is not there — the Zod
 * schemas were written against *documented* response shapes, not observed ones.
 * A field that is documented as a number and arrives as a string, or a nesting
 * level that moved, would pass every mocked test and fail on first real use.
 *
 * These assertions are loose on purpose. They check that a real payload parses
 * into the domain shape and that the fields the app depends on are populated;
 * they do not assert particular values, which would make the suite fail when a
 * citation count changes. Anything more specific belongs in the mocked tests.
 *
 * Note that running this makes real outbound requests to Crossref and OpenAlex.
 * That is exactly the traffic ADR-028 governs, which is why it is opt-in even
 * for a developer.
 */
/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { createCrossrefClient } from './crossref';
import { createOpenAlexClient } from './openalex';
import { createPubMedClient } from './pubmed';
import { approveQuery, type ApprovedQuery } from './query';

const LIVE = process.env.GRETTA_LIVE_SMOKE === '1';

/** Set to your address to exercise the polite-pool path as a real user would. */
const CONTACT = process.env.GRETTA_LIVE_SMOKE_EMAIL ?? null;

/**
 * The Wakefield MMR paper: retracted by The Lancet in 2010, and about as stable
 * a test fixture as the retraction record has.
 */
const RETRACTED_DOI = '10.1016/s0140-6736(97)11096-0';

const query = (text: string): ApprovedQuery => {
  const approval = approveQuery(text);
  if (!approval.ok) throw new Error(`query rejected: ${approval.message}`);
  return approval.query;
};

describe.skipIf(!LIVE)('live: Crossref', () => {
  it('returns records that parse into the domain shape', async () => {
    const client = createCrossrefClient({ contactEmail: CONTACT });
    const records = await client.search(query('CRISPR base editing off-target'), 5);

    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.title.length).toBeGreaterThan(0);
      expect(record.doi).not.toBeNull();
      expect(record.id.startsWith('crossref:')).toBe(true);
    }

    // Surfaced for eyeballing: abstract coverage is patchy at Crossref, and how
    // patchy determines whether local re-ranking has anything to work with.
    const withAbstracts = records.filter((record) => record.abstract !== null).length;
    console.info(
      `[smoke] crossref: ${String(records.length)} records, ` +
        `${String(withAbstracts)} with abstracts`,
    );
  }, 30_000);

  it('reports the Wakefield retraction with its type preserved', async () => {
    const client = createCrossrefClient({ contactEmail: CONTACT });
    const status = (await client.lookupUpdates([RETRACTED_DOI])).get(RETRACTED_DOI);

    expect(status?.checked).toBe(true);
    // The point of ADR-029: the notice arrives typed, not as a bare boolean.
    console.info(`[smoke] crossref updates:`, JSON.stringify(status?.updates));
    expect(status?.updates.some((update) => update.type === 'retraction')).toBe(true);
  }, 30_000);

  it('marks a clean DOI as checked with no updates', async () => {
    const client = createCrossrefClient({ contactEmail: CONTACT });
    const records = await client.search(query('protein folding prediction'), 1);
    const doi = records[0]?.doi;
    expect(doi).toBeDefined();

    const started = Date.now();
    const status = (await client.lookupUpdates([doi ?? ''])).get(doi ?? '');
    expect(status?.checked).toBe(true);
    // Isolated from the search above, because the two were previously measured
    // together and the combined figure was misread as the lookup's cost. Whether
    // a no-match `filter=updates:` query is slower than a matching one decides
    // if retraction checks can run eagerly across a result set or must be lazy.
    console.info(`[smoke] crossref update lookup, no notices: ${String(Date.now() - started)}ms`);
  }, 30_000);

  it('measures the cost of checking a whole result set for retractions', async () => {
    const client = createCrossrefClient({ contactEmail: CONTACT });
    const records = await client.search(query('hepatocyte gene editing'), 10);
    const dois = records.map((record) => record.doi).filter((doi): doi is string => doi !== null);

    const started = Date.now();
    const statuses = await client.lookupUpdates(dois);
    const elapsed = Date.now() - started;

    expect(statuses.size).toBe(dois.length);
    // The number that decides eager vs lazy. Serial by design; if this is tens
    // of seconds, a search surface cannot check every result before painting.
    console.info(
      `[smoke] crossref updates for ${String(dois.length)} DOIs: ${String(elapsed)}ms ` +
        `(${String(Math.round(elapsed / Math.max(1, dois.length)))}ms each)`,
    );
  }, 120_000);
});

describe.skipIf(!LIVE)('live: OpenAlex', () => {
  it('returns venue and citation signals that parse', async () => {
    const client = createOpenAlexClient({ contactEmail: CONTACT });
    const result = (await client.enrich([RETRACTED_DOI])).get(RETRACTED_DOI);

    expect(result).toBeDefined();
    console.info(`[smoke] openalex signals:`, JSON.stringify(result?.signals));

    // Venue-level standing is the reason OpenAlex is the credibility backbone;
    // if this comes back unknown for a Lancet paper, the mapping is wrong.
    expect(result?.signals.venueKnown).toBe(true);
    // Standing comes from the second /sources pass; null here means that pass
    // silently did nothing, not that the journal has no citation record.
    expect(result?.signals.venueMeanCitedness).not.toBeNull();
    // Deliberately NOT asserting an abstract here. This fixture is a 1998 paper
    // OpenAlex has no abstract for, and pinning coverage to one record I do not
    // control tests the fixture rather than the code. The batch case below
    // reports the rate, which is the number that actually matters.
  }, 30_000);

  it('reports an unknown DOI as checked-and-absent rather than omitting it', async () => {
    const client = createOpenAlexClient({ contactEmail: CONTACT });
    const bogus = '10.9999/definitely-not-a-real-doi';
    const result = (await client.enrich([bogus])).get(bogus);

    expect(result).toBeDefined();
    expect(result?.signals.venueKnown).toBe(false);
  }, 30_000);

  it('enriches a batch drawn from a real Crossref search', async () => {
    const crossref = createCrossrefClient({ contactEmail: CONTACT });
    const openAlex = createOpenAlexClient({ contactEmail: CONTACT });

    const records = await crossref.search(query('hepatocyte gene editing'), 10);
    const dois = records.map((record) => record.doi).filter((doi): doi is string => doi !== null);
    const enriched = await openAlex.enrich(dois);

    // Every requested DOI must come back, or the "not checked" distinction the
    // credibility badges depend on has already been lost.
    expect(enriched.size).toBe(dois.length);
    const known = [...enriched.values()].filter((entry) => entry.signals.venueKnown).length;
    const abstracts = [...enriched.values()].filter((entry) => entry.abstract !== null).length;
    console.info(
      `[smoke] openalex: ${String(known)}/${String(dois.length)} venues known, ` +
        `${String(abstracts)}/${String(dois.length)} abstracts recovered`,
    );
  }, 60_000);
});

describe.skipIf(!LIVE)('live: PubMed', () => {
  it('returns records with abstracts, which is why PubMed is here', async () => {
    const client = createPubMedClient({ contactEmail: CONTACT });
    const result = await client.searchDetailed(query('CRISPR base editing off-target'), 10);

    expect(result.records.length).toBeGreaterThan(0);

    const withAbstracts = result.records.filter((record) => record.abstract !== null).length;
    const medline = [...result.medlineIndexed.values()].filter(Boolean).length;
    // The comparison that matters: Crossref deposits abstracts for roughly one
    // record in five. If PubMed is not far better than that for biomedical
    // queries, the XML dependency has not paid for itself.
    console.info(
      `[smoke] pubmed: ${String(result.records.length)} records, ` +
        `${String(withAbstracts)} with abstracts, ${String(medline)} MEDLINE-indexed`,
    );
    console.info(`[smoke] pubmed first title: ${result.records[0]?.title ?? '(none)'}`);
  }, 60_000);

  it('preserves words inside inline markup in titles', async () => {
    // Mixed content silently deleted a word before stopNodes; a mangled title
    // still looks like a title, so this is checked against real records.
    const client = createPubMedClient({ contactEmail: CONTACT });
    const result = await client.search(query('gene expression Drosophila'), 10);

    for (const record of result) {
      expect(record.title).not.toMatch(/\p{Ll}\p{Lu}/u);
      expect(record.title).not.toContain('<');
    }
  }, 60_000);
});

describe.skipIf(!LIVE)('live: retrieval quality', () => {
  /**
   * The case that prompted this: a passage naming specific tools should return
   * the papers introducing them. Crossref's bibliographic index returns
   * loosely-related older work for the same string, which is why OpenAlex
   * became a search source rather than only an enrichment one.
   */
  const NAMED_TOOLS =
    'protein structure prediction AlphaFold3 Chai-1 Boltz-2 RFdiffusion atomic resolution';

  it('OpenAlex finds recent work naming specific tools', async () => {
    const client = createOpenAlexClient({ contactEmail: CONTACT });
    const records = await client.search(query(NAMED_TOOLS), 20, 2021);

    expect(records.length).toBeGreaterThan(0);
    const years = records.map((record) => record.issued?.year ?? 0);
    console.info(
      `[smoke] openalex search: ${String(records.length)} records, ` +
        `median year ${String(years.sort((a, b) => a - b)[Math.floor(years.length / 2)] ?? 0)}`,
    );
    for (const record of records.slice(0, 5)) {
      console.info(`[smoke]   ${String(record.issued?.year ?? '????')} — ${record.title}`);
    }
    // The year filter is a stated constraint, so nothing older should appear.
    expect(records.every((record) => (record.issued?.year ?? 9999) >= 2021)).toBe(true);
  }, 60_000);

  it('PubMed returns something for a multi-keyword query', async () => {
    // Its Automatic Term Mapping ANDs terms, so this returned nothing at all
    // before progressive relaxation.
    const client = createPubMedClient({ contactEmail: CONTACT });
    const records = await client.search(query(NAMED_TOOLS), 10);

    console.info(`[smoke] pubmed multi-keyword: ${String(records.length)} records`);
    expect(records.length).toBeGreaterThan(0);
  }, 60_000);
});

describe.skipIf(!LIVE)('live: arXiv (unsupported — standing check)', () => {
  /**
   * The question this settles is **not** whether the search API works — it
   * plainly does — but whether a browser is allowed to call it. Node does not
   * enforce CORS, so a passing request here proves nothing about the task pane.
   * What Node *can* see is the response header, and that is the actual answer:
   * if `Access-Control-Allow-Origin` is absent, no browser will let the pane
   * read the response, however healthy the request looks from a terminal.
   */
  it('reports whether arXiv permits browser origins', async () => {
    const response = await fetch(
      'https://export.arxiv.org/api/query?search_query=all:protein&max_results=1',
    );
    const allowOrigin = response.headers.get('access-control-allow-origin');

    console.info(
      `[smoke] arxiv CORS: ${allowOrigin === null ? 'ABSENT — the task pane cannot use this API' : `present (${allowOrigin})`}`,
    );
    // Deliberately not asserted. This test records a fact about arXiv's server
    // that GRETTA does not control; failing the suite over it would be noise.
    expect(response.ok).toBe(true);
  }, 30_000);
});

describe.skipIf(!LIVE)('live: preprints via Crossref', () => {
  /**
   * bioRxiv and medRxiv publish no keyword search API, but both deposit into
   * Crossref, which does. Three things need to hold and none was observed when
   * the code was written: that the `type:posted-content` plus DOI-prefix filter
   * returns preprints at all, that both openRxiv prefixes are covered, and that
   * the two servers can be told apart — they share every prefix, so separation
   * depends on a name Crossref may or may not carry.
   */
  it('finds bioRxiv preprints and keeps medRxiv out of them', async () => {
    const client = createCrossrefClient({ contactEmail: CONTACT });
    const records = await client.searchPreprints(query('CRISPR base editing'), 20, 'biorxiv');

    console.info(`[smoke] biorxiv via crossref: ${String(records.length)} records`);
    for (const record of records.slice(0, 3)) {
      console.info(
        `[smoke]   ${String(record.issued?.year ?? '????')} — ${record.doi ?? 'no doi'} — ${record.title}`,
      );
    }
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.type === 'preprint')).toBe(true);
  }, 60_000);

  it('finds medRxiv preprints separately', async () => {
    const client = createCrossrefClient({ contactEmail: CONTACT });
    const records = await client.searchPreprints(
      query('SARS-CoV-2 vaccine effectiveness'),
      20,
      'medrxiv',
    );

    console.info(`[smoke] medrxiv via crossref: ${String(records.length)} records`);
    for (const record of records.slice(0, 3)) {
      console.info(`[smoke]   ${record.doi ?? 'no doi'} — ${record.title}`);
    }
    expect(records.length).toBeGreaterThan(0);
  }, 60_000);

  it('covers both openRxiv DOI prefixes, not just the older one', async () => {
    // 10.1101 is Cold Spring Harbor's; openRxiv began issuing 10.64898 on
    // 1 December 2025. Filtering on one alone silently hides half the corpus,
    // and which half depends on the date — the kind of gap that looks like
    // thin coverage rather than a bug.
    const client = createCrossrefClient({ contactEmail: CONTACT });
    const recent = await client.searchPreprints(query('protein language model'), 50, 'biorxiv');

    const prefixes = new Set(
      recent.map((record) => record.doi?.split('/')[0] ?? 'none').filter((p) => p !== 'none'),
    );
    console.info(`[smoke] biorxiv prefixes seen: ${[...prefixes].join(', ') || '(none)'}`);
    expect(recent.length).toBeGreaterThan(0);
  }, 60_000);

  it('separates the two servers rather than returning the same set twice', async () => {
    const client = createCrossrefClient({ contactEmail: CONTACT });
    const term = query('clinical trial machine learning');

    const bio = await client.searchPreprints(term, 20, 'biorxiv');
    const med = await client.searchPreprints(term, 20, 'medrxiv');

    const bioDois = new Set(bio.map((record) => record.doi));
    const overlap = med.filter((record) => bioDois.has(record.doi)).length;

    console.info(
      `[smoke] separation: ${String(bio.length)} bioRxiv, ${String(med.length)} medRxiv, ` +
        `${String(overlap)} in both`,
    );
    // Any overlap means the server name is not distinguishing them and both
    // toggles are showing the same corpus under different labels.
    expect(overlap).toBe(0);
  }, 90_000);
});

describe.skipIf(!LIVE)('live: DataCite as a route to arXiv', () => {
  /**
   * arXiv registers its DOIs with DataCite, not Crossref, which is why the
   * Crossref preprint route cannot reach it. DataCite's own REST API does
   * support keyword search and prefix filtering, so `?query=…&prefix=10.48550`
   * is the exact analogue of what works for bioRxiv and medRxiv.
   *
   * Whether GRETTA can *use* it is a separate question, and it is the one that
   * sank the direct arXiv client: a search API being excellent is irrelevant if
   * the server forbids browser origins. So this probe answers that first,
   * before any client is written against it. Measure, then build.
   */
  const DATACITE = 'https://api.datacite.org/dois';
  const ARXIV_PREFIX = '10.48550';

  it('reports whether DataCite permits browser origins', async () => {
    const response = await fetch(`${DATACITE}?query=protein&prefix=${ARXIV_PREFIX}&page[size]=1`);
    const allowOrigin = response.headers.get('access-control-allow-origin');

    console.info(
      `[smoke] datacite CORS: ${
        allowOrigin === null
          ? 'ABSENT — no better than arXiv direct, do not build the client'
          : `present (${allowOrigin}) — viable route to arXiv`
      }`,
    );
    expect(response.ok).toBe(true);
  }, 30_000);

  it('returns arXiv preprints with titles and abstracts', async () => {
    // Coverage matters as much as access: a route that reaches arXiv but
    // carries no abstracts gives the local re-ranker nothing to embed.
    const response = await fetch(
      `${DATACITE}?query=protein%20structure%20prediction&prefix=${ARXIV_PREFIX}&page[size]=10`,
    );
    const body = (await response.json()) as {
      data?: {
        attributes?: {
          titles?: { title?: string }[];
          descriptions?: { description?: string; descriptionType?: string }[];
          publicationYear?: number;
        };
      }[];
    };

    const items = body.data ?? [];
    const withAbstract = items.filter((item) =>
      (item.attributes?.descriptions ?? []).some(
        (description) => description.descriptionType === 'Abstract',
      ),
    ).length;

    console.info(
      `[smoke] datacite/arxiv: ${String(items.length)} records, ` +
        `${String(withAbstract)} with abstracts`,
    );
    for (const item of items.slice(0, 3)) {
      console.info(
        `[smoke]   ${String(item.attributes?.publicationYear ?? '????')} — ` +
          (item.attributes?.titles?.[0]?.title ?? '(untitled)'),
      );
    }
    expect(items.length).toBeGreaterThan(0);
  }, 30_000);
});

describe.skipIf(!LIVE)('live: Semantic Scholar as an open alternative', () => {
  /**
   * The nearest open equivalent to Google Scholar, which has no API at all and
   * prohibits scraping. Semantic Scholar is run by the Allen Institute, is free
   * without an account, indexes preprints alongside published work, and carries
   * abstracts, citation counts, and open-access PDF links.
   *
   * As with DataCite, capability is the easy half. The probe answers the
   * question that actually decides it — whether a browser may read the
   * response — before any client is written. Two sources have now been designed
   * against and discarded on this exact point.
   */
  const S2 = 'https://api.semanticscholar.org/graph/v1/paper/search';
  const FIELDS = 'title,abstract,year,venue,externalIds,openAccessPdf,citationCount';

  it('reports whether Semantic Scholar permits browser origins', async () => {
    const response = await fetch(`${S2}?query=protein&limit=1&fields=title`);
    const allowOrigin = response.headers.get('access-control-allow-origin');

    console.info(
      `[smoke] semantic scholar CORS: ${
        allowOrigin === null
          ? 'ABSENT — unusable from the task pane, do not build the client'
          : `present (${allowOrigin}) — viable`
      }`,
    );
    // Unauthenticated callers are throttled; a 429 here is informative, not a
    // failure of the thing being measured.
    console.info(`[smoke] semantic scholar status: ${String(response.status)}`);
  }, 30_000);

  it('returns records with abstracts and preprint coverage', async () => {
    const response = await fetch(
      `${S2}?query=${encodeURIComponent('protein structure prediction AlphaFold')}` +
        `&limit=10&fields=${FIELDS}`,
    );
    if (!response.ok) {
      console.info(`[smoke] semantic scholar unavailable: HTTP ${String(response.status)}`);
      return;
    }

    const body = (await response.json()) as {
      data?: {
        title?: string;
        abstract?: string | null;
        year?: number | null;
        venue?: string;
        openAccessPdf?: { url?: string } | null;
      }[];
    };
    const items = body.data ?? [];
    const withAbstract = items.filter((item) => (item.abstract ?? '') !== '').length;
    const withPdf = items.filter((item) => item.openAccessPdf?.url !== undefined).length;

    console.info(
      `[smoke] semantic scholar: ${String(items.length)} records, ` +
        `${String(withAbstract)} with abstracts, ${String(withPdf)} with open-access PDFs`,
    );
    for (const item of items.slice(0, 3)) {
      console.info(
        `[smoke]   ${String(item.year ?? '????')} — ${item.venue ?? 'no venue'} — ` +
          (item.title ?? '(untitled)'),
      );
    }
  }, 30_000);
});
