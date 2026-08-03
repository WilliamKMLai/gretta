/**
 * PubMed tests — mocked at the transport seam (ARCHITECTURE.md §14).
 *
 * The XML fixtures are trimmed but structurally real: a structured abstract
 * with section labels, a collective author, a mixed publication-type list, and
 * a citation that is present in PubMed without being MEDLINE-indexed. Those are
 * the shapes that distinguish PubMed from the JSON sources, and inventing
 * tidier ones would test a format NCBI does not emit.
 */
import { describe, expect, it, vi } from 'vitest';
import { LiteratureError } from '../../types/errors';
import type { HttpTransport } from './client.types';
import { createPubMedClient } from './pubmed';
import { parseArticleSet, parsePmidList } from './pubmed.schemas';
import { approveQuery, type ApprovedQuery } from './query';

const query = (text = 'base editing hepatocyte'): ApprovedQuery => {
  const approval = approveQuery(text);
  if (!approval.ok) throw new Error('test query rejected');
  return approval.query;
};

const ARTICLE_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation Status="MEDLINE">
      <PMID>12345678</PMID>
      <Article>
        <Journal>
          <JournalIssue><PubDate><Year>2024</Year><Month>Mar</Month></PubDate></JournalIssue>
          <Title>The Lancet</Title>
        </Journal>
        <ArticleTitle>Base editing in <i>primary</i> hepatocytes</ArticleTitle>
        <Abstract>
          <AbstractText Label="BACKGROUND">Off-target effects remain a concern.</AbstractText>
          <AbstractText Label="RESULTS">We observed fewer events at all loci.</AbstractText>
        </Abstract>
        <AuthorList>
          <Author><LastName>Doe</LastName><ForeName>Jane</ForeName></Author>
          <Author><CollectiveName>The Editing Consortium</CollectiveName></Author>
        </AuthorList>
        <PublicationTypeList>
          <PublicationType>Journal Article</PublicationType>
          <PublicationType>Review</PublicationType>
        </PublicationTypeList>
      </Article>
    </MedlineCitation>
    <PubmedData>
      <ArticleIdList>
        <ArticleId IdType="pubmed">12345678</ArticleId>
        <ArticleId IdType="doi">10.1000/example</ArticleId>
      </ArticleIdList>
    </PubmedData>
  </PubmedArticle>
</PubmedArticleSet>`;

describe('parsePmidList', () => {
  it('reads the id list from an esearch response', () => {
    expect(parsePmidList({ esearchresult: { idlist: ['1', '2'] } })).toEqual(['1', '2']);
  });

  it('returns an empty list for a malformed payload', () => {
    expect(parsePmidList({ unexpected: true })).toEqual([]);
    expect(parsePmidList('nonsense')).toEqual([]);
  });
});

describe('parseArticleSet', () => {
  it('maps a citation into the domain shape', () => {
    const [article] = parseArticleSet(ARTICLE_XML);

    expect(article?.record.pmid).toBe('12345678');
    expect(article?.record.doi).toBe('10.1000/example');
    expect(article?.record.containerTitle).toBe('The Lancet');
    expect(article?.record.issued).toEqual({ year: 2024, month: 3, day: null });
    expect(article?.record.discoveredVia).toBe('pubmed');
  });

  it('strips inline markup from the title', () => {
    expect(parseArticleSet(ARTICLE_XML)[0]?.record.title).toBe(
      'Base editing in primary hepatocytes',
    );
  });

  it('keeps section labels when joining a structured abstract', () => {
    // Dropping them would merge a conclusion into a method.
    const abstract = parseArticleSet(ARTICLE_XML)[0]?.record.abstract ?? '';
    expect(abstract).toContain('BACKGROUND: Off-target effects remain a concern.');
    expect(abstract).toContain('RESULTS: We observed fewer events at all loci.');
  });

  it('keeps a collective author as a literal name', () => {
    expect(parseArticleSet(ARTICLE_XML)[0]?.record.authors[1]).toEqual({
      family: 'The Editing Consortium',
      given: null,
    });
  });

  it('picks the most specific publication type, not the first', () => {
    // "Journal Article" is listed first but "Review" is what it is.
    expect(parseArticleSet(ARTICLE_XML)[0]?.record.type).toBe('review');
  });

  it('reads MEDLINE indexing from the citation status', () => {
    expect(parseArticleSet(ARTICLE_XML)[0]?.medlineIndexed).toBe(true);
  });

  it('does not treat in-process citations as MEDLINE-indexed', () => {
    // Present in PubMed is broader than passing NLM's selection review.
    const inProcess = ARTICLE_XML.replace('Status="MEDLINE"', 'Status="PubMed-not-MEDLINE"');
    expect(parseArticleSet(inProcess)[0]?.medlineIndexed).toBe(false);
  });

  it('drops one unparseable citation rather than the whole set', () => {
    // Crossref taught this expensively: an all-or-nothing parse there meant a
    // single undated record emptied entire searches.
    const withJunk = ARTICLE_XML.replace(
      '<PubmedArticle>',
      '<PubmedArticle><MedlineCitation/></PubmedArticle><PubmedArticle>',
    );
    expect(parseArticleSet(withJunk)).toHaveLength(1);
  });

  it('returns an empty list for malformed or unrelated XML', () => {
    expect(parseArticleSet('<not-what-we-asked-for/>')).toEqual([]);
    expect(parseArticleSet('')).toEqual([]);
  });

  it('handles a record with no abstract or DOI', () => {
    const bare = `<PubmedArticleSet><PubmedArticle><MedlineCitation Status="MEDLINE">
      <PMID>999</PMID><Article><ArticleTitle>Bare</ArticleTitle></Article>
      </MedlineCitation></PubmedArticle></PubmedArticleSet>`;
    const [article] = parseArticleSet(bare);
    expect(article?.record.abstract).toBeNull();
    expect(article?.record.doi).toBeNull();
    expect(article?.record.issued).toBeNull();
  });
});

describe('createPubMedClient', () => {
  const routed = (ids: string[], xml = ARTICLE_XML): HttpTransport =>
    vi.fn((url: string) =>
      Promise.resolve(
        url.includes('esearch')
          ? new Response(JSON.stringify({ esearchresult: { idlist: ids } }))
          : new Response(xml),
      ),
    );

  it('searches then fetches, and returns parsed records', async () => {
    const transport = routed(['12345678']);
    const records = await createPubMedClient({
      transport,
      initialPacingMs: 0,
    }).search(query(), 5);

    expect(records).toHaveLength(1);
    expect(records[0]?.pmid).toBe('12345678');
    const paths = vi.mocked(transport).mock.calls.map((call) => call[0]);
    expect(paths[0]).toContain('esearch.fcgi');
    expect(paths[1]).toContain('efetch.fcgi');
  });

  it('skips the fetch entirely when no search finds anything', async () => {
    const transport = routed([]);
    expect(await createPubMedClient({ transport, initialPacingMs: 0 }).search(query(), 5)).toEqual(
      [],
    );
    expect(vi.mocked(transport).mock.calls.every((call) => !call[0].includes('efetch'))).toBe(true);
  });

  it('retries with OR when the strict query matches nothing', async () => {
    // PubMed's Automatic Term Mapping ANDs every term, so a query derived from
    // a passage asks for one paper containing all of them and returns zero.
    // This is why PubMed alone found nothing while Crossref found results.
    let call = 0;
    const transport: HttpTransport = vi.fn((url: string) => {
      if (url.includes('efetch')) return Promise.resolve(new Response(ARTICLE_XML));
      call += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ esearchresult: { idlist: call === 1 ? [] : ['12345678'] } })),
      );
    });

    const records = await createPubMedClient({
      transport,
      initialPacingMs: 0,
    }).search(query(), 5);

    const searches = vi.mocked(transport).mock.calls.filter((c) => c[0].includes('esearch'));
    expect(searches).toHaveLength(2);
    expect(searches[0]?.[0]).not.toContain('OR');
    expect(decodeURIComponent(searches[1]?.[0] ?? '')).toContain(' OR ');
    expect(records).toHaveLength(1);
  });

  it('does not relax a single-term query, which has nothing to loosen', async () => {
    const transport = routed([]);
    await createPubMedClient({ transport, initialPacingMs: 0 }).search(query('crispr'), 5);

    const searches = vi.mocked(transport).mock.calls.filter((c) => c[0].includes('esearch'));
    expect(searches).toHaveLength(1);
  });

  it('identifies itself to NCBI, and sends an address only when configured', async () => {
    const anonymous = routed([]);
    await createPubMedClient({ transport: anonymous, initialPacingMs: 0 }).search(query(), 5);
    expect(vi.mocked(anonymous).mock.calls[0]?.[0]).toContain('tool=gretta');
    expect(vi.mocked(anonymous).mock.calls[0]?.[0]).not.toContain('email=');

    const polite = routed([]);
    await createPubMedClient({
      transport: polite,
      contactEmail: 'a@b.org',
      initialPacingMs: 0,
    }).search(query(), 5);
    expect(vi.mocked(polite).mock.calls[0]?.[0]).toContain('email=a%40b.org');
  });

  it('sends no User-Agent, keeping the request simple enough for a webview', async () => {
    const transport = routed([]);
    await createPubMedClient({ transport, initialPacingMs: 0 }).search(query(), 5);

    const headers = vi.mocked(transport).mock.calls[0]?.[1].headers ?? {};
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('user-agent');
  });

  it('surfaces MEDLINE status per PMID in the detailed search', async () => {
    const result = await createPubMedClient({
      transport: routed(['12345678']),
      initialPacingMs: 0,
    }).searchDetailed(query(), 5);
    expect(result.medlineIndexed.get('12345678')).toBe(true);
  });

  it('raises a typed error when the transport fails', async () => {
    const transport: HttpTransport = vi.fn(() => Promise.reject(new TypeError('network')));
    await expect(
      createPubMedClient({ transport, initialPacingMs: 0 }).search(query(), 5),
    ).rejects.toBeInstanceOf(LiteratureError);
  });

  it('raises invalid-response when esearch returns something other than JSON', async () => {
    const transport: HttpTransport = vi.fn(() => Promise.resolve(new Response('<html/>')));
    await expect(
      createPubMedClient({ transport, initialPacingMs: 0 }).search(query(), 5),
    ).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('does not retry a 400', async () => {
    const transport: HttpTransport = vi.fn(() =>
      Promise.resolve(new Response('', { status: 400 })),
    );
    await expect(
      createPubMedClient({ transport, initialPacingMs: 0 }).search(query(), 5),
    ).rejects.toMatchObject({
      kind: 'http',
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
