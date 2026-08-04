/**
 * `resolveCacheHit` tests (DECISIONS.md ADR-028): the fast path a repeat
 * search needs to actually feel instant, not just skip the network.
 */
import type { OllamaClient } from '../../services/ollama';
import type { AssessedRecord, LiteratureRecord } from '../../types/literature';
import { hashPassage, readCache, writeCache } from './cache';
import type { CacheEntry } from './cache';
import { mergeRecords, rank, resolveCacheHit } from './searchPipeline';

function record(id: string): AssessedRecord {
  return {
    record: {
      id,
      doi: `10.1/${id}`,
      pmid: null,
      arxivId: null,
      openAlexId: null,
      title: `Paper ${id}`,
      authors: [],
      containerTitle: null,
      issued: null,
      abstract: 'an abstract',
      type: 'article',
      url: null,
      discoveredVia: 'pubmed',
    },
    signals: { openAlex: null, pubmed: null, crossref: null },
    updates: { checked: false, updates: [] },
    relevance: 0.9,
    stance: null,
    tier: 'queued',
  };
}

function cachedEntry(passage: string): CacheEntry {
  return {
    key: 'k',
    storedAt: new Date().toISOString(),
    results: [record('a')],
    ranking: 'semantic',
    hiddenCount: 0,
    rankingNote: null,
    sentQueries: [{ source: 'PubMed', query: 'cats' }],
    query: 'cats',
    sources: ['pubmed'],
    fromYear: null,
    resultsPerSource: 50,
    passageHash: hashPassage(passage),
  };
}

function stubOllama(embed: OllamaClient['embed']): OllamaClient {
  return {
    health: () => {
      throw new Error('unused');
    },
    listModels: () => {
      throw new Error('unused');
    },
    showModel: () => {
      throw new Error('unused');
    },
    embed,
    chat: () => {
      throw new Error('unused');
    },
    generate: () => {
      throw new Error('unused');
    },
  };
}

const settings = { defaultEmbeddingModel: 'nomic-embed-text', litCitationImpactWeight: 0.25 };

/**
 * Same shape as `record()`, but with an OpenAlex citation-impact signal set.
 * `citedByCount` defaults to a nonzero value so these fixtures exercise
 * percentile-driven boosting by default; pass `0` explicitly for the
 * zero-citations-means-zero-impact cases.
 */
function recordWithPercentile(
  id: string,
  citedByPercentileYear: number,
  citedByCount: number | null = 10,
): AssessedRecord {
  return {
    ...record(id),
    signals: {
      openAlex: {
        venueKnown: true,
        venueInDoaj: null,
        venueIsOa: null,
        venueMeanCitedness: null,
        venueHIndex: null,
        venueApcUsd: null,
        fwci: null,
        citedByPercentileYear,
        citedByCount,
        isParatext: null,
      },
      pubmed: null,
      crossref: null,
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('rank citation impact', () => {
  it('breaks an equal-relevance tie in favor of higher citation impact', async () => {
    // Both candidates embed identically to the passage, so relevance ties —
    // only the citation-impact nudge (DECISIONS.md ADR-029's amendment)
    // decides the order.
    const embed = vi.fn<OllamaClient['embed']>((_model, input) =>
      Promise.resolve(input.map(() => [1, 0])),
    );
    const ollama = stubOllama(embed);

    const { ordered } = await rank(
      [recordWithPercentile('low', 10), recordWithPercentile('high', 90)],
      'a passage',
      ollama,
      settings,
      new AbortController(),
    );

    expect(ordered.map((entry) => entry.record.id)).toEqual(['high', 'low']);
  });

  it('does not let a maximally-cited but irrelevant candidate beat a clearly relevant one', async () => {
    const embed = vi.fn<OllamaClient['embed']>((_model, [, ...texts]: readonly string[]) =>
      Promise.resolve(
        // Passage vector first, then one per candidate: "relevant" matches
        // the passage direction, "cited" is orthogonal to it.
        [[1, 0], ...texts.map((_, index) => (index === 0 ? [1, 0] : [0, 1]))],
      ),
    );
    const ollama = stubOllama(embed);

    const { ordered } = await rank(
      [recordWithPercentile('relevant', 0), recordWithPercentile('cited', 100)],
      'a passage',
      ollama,
      settings,
      new AbortController(),
    );

    expect(ordered.map((entry) => entry.record.id)).toEqual(['relevant', 'cited']);
  });

  it('reads the weight from settings — 0 disables the nudge entirely', async () => {
    // Same equal-relevance setup as the first test, but with the weight
    // turned off: without it, ties fall back to relevance-ranking's own
    // stable tie-break (input order), not citation impact.
    const embed = vi.fn<OllamaClient['embed']>((_model, input) =>
      Promise.resolve(input.map(() => [1, 0])),
    );
    const ollama = stubOllama(embed);

    const { ordered } = await rank(
      [recordWithPercentile('low', 10), recordWithPercentile('high', 90)],
      'a passage',
      ollama,
      { ...settings, litCitationImpactWeight: 0 },
      new AbortController(),
    );

    expect(ordered.map((entry) => entry.record.id)).toEqual(['low', 'high']);
  });

  it('gives zero citations zero impact, even behind a deceptively high percentile', async () => {
    // User-reported and confirmed: a brand-new paper with 0 citations can
    // still carry a high `citedByPercentileYear` — early in a same-year
    // cohort, most other papers are also at 0 citations yet, and percentile
    // ties at the minimum get assigned that whole mass's percentile. A
    // paper with 58 real citations must not lose to one with none just
    // because OpenAlex's percentile for an empty cohort is noisy.
    const embed = vi.fn<OllamaClient['embed']>((_model, input) =>
      Promise.resolve(input.map(() => [1, 0])),
    );
    const ollama = stubOllama(embed);

    const { ordered } = await rank(
      [
        recordWithPercentile('zero-citations', 99, 0),
        recordWithPercentile('fifty-eight-citations', 50, 58),
      ],
      'a passage',
      ollama,
      settings,
      new AbortController(),
    );

    expect(ordered.map((entry) => entry.record.id)).toEqual([
      'fifty-eight-citations',
      'zero-citations',
    ]);
  });
});

describe('mergeRecords', () => {
  function preprint(
    id: string,
    doi: string | null,
    title: string,
    abstract: string | null,
  ): LiteratureRecord {
    return {
      id,
      doi,
      pmid: null,
      arxivId: null,
      openAlexId: null,
      title,
      authors: [],
      containerTitle: null,
      issued: null,
      abstract,
      type: 'preprint',
      url: null,
      discoveredVia: 'openalex',
    };
  }

  it('merges the same DOI across source groups, preferring the record with an abstract', () => {
    const withoutAbstract = preprint('a', '10.1/x', 'A Paper', null);
    const withAbstract = preprint('b', '10.1/x', 'A Paper', 'Findings.');
    const merged = mergeRecords([[withoutAbstract], [withAbstract]]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.abstract).toBe('Findings.');
  });

  it('merges the same work cross-listed under different DOIs by normalized title', () => {
    // User-reported: the same preprint deposited on Open MIND and twice on
    // Figshare, each with its own DOI, occupied three ranked positions.
    const openMind = preprint(
      'a',
      '10.1/openmind',
      'Rodenticide Innovations Through BoltzGen',
      null,
    );
    const figshare1 = preprint(
      'b',
      '10.2/figshare-1',
      'rodenticide innovations through boltzgen',
      null,
    );
    const figshare2 = preprint(
      'c',
      '10.3/figshare-2',
      '  Rodenticide   innovations, through BoltzGen!  ',
      'An abstract, finally.',
    );

    const merged = mergeRecords([[openMind, figshare1, figshare2]]);

    expect(merged).toHaveLength(1);
    // The abstract-bearing copy wins, same rule as the DOI pass.
    expect(merged[0]?.abstract).toBe('An abstract, finally.');
  });

  it('does not merge genuinely different papers that happen to share a DOI-less blank title', () => {
    const first = preprint('a', null, '', null);
    const second = preprint('b', null, '', null);
    const merged = mergeRecords([[first, second]]);
    expect(merged.map((record) => record.id)).toEqual(['a', 'b']);
  });

  it('leaves unrelated titles alone', () => {
    const a = preprint('a', '10.1/a', 'Paper A', null);
    const b = preprint('b', '10.2/b', 'Paper B', null);
    const merged = mergeRecords([[a, b]]);
    expect(merged.map((record) => record.id)).toEqual(['a', 'b']);
  });
});

describe('resolveCacheHit', () => {
  it('reuses the stored ordering with no embed calls when the passage matches', async () => {
    const embed = vi.fn<OllamaClient['embed']>();
    const ollama = stubOllama(embed);
    const cached = cachedEntry('the same passage');
    const setResults = vi.fn();

    await resolveCacheHit(
      'k',
      cached,
      'the same passage',
      ollama,
      settings,
      new AbortController(),
      setResults,
    );

    expect(embed).not.toHaveBeenCalled();
    expect(setResults).toHaveBeenCalledWith(
      cached.results,
      cached.ranking,
      cached.hiddenCount,
      cached.rankingNote,
      cached.sentQueries,
    );
  });

  it('re-ranks and re-caches under the new passage hash when the passage differs', async () => {
    const embed = vi.fn<OllamaClient['embed']>((_model, input) =>
      Promise.resolve(input.map(() => [1, 0])),
    );
    const ollama = stubOllama(embed);
    const cached = cachedEntry('the original passage');
    const setResults = vi.fn();
    await writeCache('k', cached);

    await resolveCacheHit(
      'k',
      cached,
      'a completely different passage',
      ollama,
      settings,
      new AbortController(),
      setResults,
    );

    expect(embed).toHaveBeenCalled();
    expect(setResults).toHaveBeenCalled();

    const updated = await readCache('k');
    expect(updated?.passageHash).toBe(hashPassage('a completely different passage'));
    expect(updated?.passageHash).not.toBe(cached.passageHash);
  });
});
