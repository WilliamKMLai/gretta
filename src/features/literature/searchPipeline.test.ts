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
    failedSources: [],
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

/** The shipped default weight (ADR-029, fifth amendment), not a test-local
 * number: these cases are claims about what a user actually gets. */
const settings = { defaultEmbeddingModel: 'nomic-embed-text', litCitationImpactWeight: 0.6 };

/**
 * Same shape as `record()`, but with an OpenAlex citation signal set.
 *
 * `citedByPercentileYear` defaults to **null**, which is the case that
 * mattered: OpenAlex leaves it unpopulated for most preprints and recent
 * deposits, and ranking must not depend on it (ADR-029, fifth amendment).
 * It is still settable so the tests can prove it is ignored.
 */
function recordWithCitations(
  id: string,
  citedByCount: number | null,
  citedByPercentileYear: number | null = null,
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

/** Every candidate embeds identically to the passage, so relevance ties and
 * only the citation nudge decides the order. */
function tiedRelevance(): OllamaClient {
  return stubOllama(
    vi.fn<OllamaClient['embed']>((_model, input) => Promise.resolve(input.map(() => [1, 0]))),
  );
}

describe('rank citation impact', () => {
  it('breaks an equal-relevance tie in favor of more citations', async () => {
    const { ordered } = await rank(
      [recordWithCitations('low', 10), recordWithCitations('high', 90)],
      'a passage',
      tiedRelevance(),
      settings,
      new AbortController(),
    );

    expect(ordered.map((entry) => entry.record.id)).toEqual(['high', 'low']);
  });

  it('boosts a heavily cited record whose year percentile OpenAlex never computed', async () => {
    // The BoltzGen report (ADR-029, fifth amendment). Impact used to be
    // `citedByPercentileYear / 100` with null mapped to 0, so a 2025 preprint
    // with 59 citations and no percentile scored exactly the same zero impact
    // as a 2026 Figshare deposit with none, and the boost cancelled out on the
    // one comparison it existed to decide. Both percentiles are null here, as
    // they were in the real result set.
    const { ordered } = await rank(
      [recordWithCitations('uncited-deposit', 0), recordWithCitations('cited-preprint', 59)],
      'a passage',
      tiedRelevance(),
      settings,
      new AbortController(),
    );

    expect(ordered.map((entry) => entry.record.id)).toEqual(['cited-preprint', 'uncited-deposit']);
  });

  it('lets a well-cited record overtake a more relevant uncited one at the default weight', async () => {
    // The behavioural change, stated as a test rather than left implicit: at
    // 0.6 the nudge is no longer only a tie-break. The uncited record is the
    // better semantic match (cosine 1.0 against the cited record's 0.71) and
    // still loses, because 59 citations is worth ~0.46 here.
    const embed = vi.fn<OllamaClient['embed']>((_model, [, ...texts]: readonly string[]) =>
      Promise.resolve([[1, 0], ...texts.map((_, index) => (index === 0 ? [1, 0] : [1, 1]))]),
    );

    const { ordered } = await rank(
      [recordWithCitations('uncited-exact-match', 0), recordWithCitations('cited', 59)],
      'a passage',
      stubOllama(embed),
      settings,
      new AbortController(),
    );

    expect(ordered.map((entry) => entry.record.id)).toEqual(['cited', 'uncited-exact-match']);
  });

  it('saturates, so a decades-old blockbuster barely outscores a recent well-cited paper', async () => {
    // Why a raw count is safe to use despite rewarding age: the curve is
    // log-scaled, so 500 citations beats 59 by ~0.23 rather than by 8x. Made
    // observable by pitting them against a relevance gap that 0.23 cannot
    // close but a linear scale easily would.
    const embed = vi.fn<OllamaClient['embed']>((_model, [, ...texts]: readonly string[]) =>
      Promise.resolve([[1, 0], ...texts.map((_, index) => (index === 0 ? [1, 0] : [1, 1]))]),
    );

    const { ordered } = await rank(
      [recordWithCitations('recent-59', 59), recordWithCitations('ancient-500', 500)],
      'a passage',
      stubOllama(embed),
      settings,
      new AbortController(),
    );

    expect(ordered.map((entry) => entry.record.id)).toEqual(['recent-59', 'ancient-500']);
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
      [recordWithCitations('relevant', 0), recordWithCitations('cited', 5000)],
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
      [recordWithCitations('low', 10), recordWithCitations('high', 90)],
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
        recordWithCitations('zero-citations', 0, 99),
        recordWithCitations('fifty-eight-citations', 58, 50),
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

describe('rank supplementary demotion', () => {
  /** A record of a given work type, with no citation signal either way. */
  function typed(id: string, type: LiteratureRecord['type']): AssessedRecord {
    const base = record(id);
    return { ...base, record: { ...base.record, type } };
  }

  /** OpenAlex asserting a record is not a research work at all. */
  function paratext(id: string): AssessedRecord {
    const entry = recordWithCitations(id, 0);
    const openAlex = entry.signals.openAlex;
    if (openAlex === null) throw new Error('fixture lost its OpenAlex signal');
    return { ...entry, signals: { ...entry.signals, openAlex: { ...openAlex, isParatext: true } } };
  }

  it('sinks a dataset deposit below an equally relevant article', async () => {
    // The reported case: a Figshare deposit accompanying a preprint, sitting
    // above the work it belongs to.
    const { ordered } = await rank(
      [typed('figshare-deposit', 'dataset'), typed('the-paper', 'article')],
      'a passage',
      tiedRelevance(),
      settings,
      new AbortController(),
    );

    expect(ordered.map((entry) => entry.record.id)).toEqual(['the-paper', 'figshare-deposit']);
  });

  it('sinks paratext below everything, on OpenAlex saying so directly', async () => {
    const { ordered } = await rank(
      [paratext('issue-cover'), typed('the-paper', 'article')],
      'a passage',
      tiedRelevance(),
      settings,
      new AbortController(),
    );

    expect(ordered.map((entry) => entry.record.id)).toEqual(['the-paper', 'issue-cover']);
  });

  it('keeps an erratum notice below the literature it corrects', async () => {
    const { ordered } = await rank(
      [typed('correction-notice', 'erratum'), typed('the-paper', 'article')],
      'a passage',
      tiedRelevance(),
      settings,
      new AbortController(),
    );

    expect(ordered.map((entry) => entry.record.id)).toEqual(['the-paper', 'correction-notice']);
  });

  it('demotes an editorial only as a tie-break, not out of contention', async () => {
    // An editorial, commentary, or perspective is real citable scholarly
    // writing. It loses to an equally relevant research article...
    const tied = await rank(
      [typed('an-editorial', 'editorial'), typed('an-article', 'article')],
      'a passage',
      tiedRelevance(),
      settings,
      new AbortController(),
    );
    expect(tied.ordered.map((entry) => entry.record.id)).toEqual(['an-article', 'an-editorial']);

    // ...but a clearly better match still wins, which is what separates a
    // tie-break from a demotion. The editorial embeds at cosine 1.0 against
    // the article's 0.71.
    const embed = vi.fn<OllamaClient['embed']>((_model, [, ...texts]: readonly string[]) =>
      Promise.resolve([[1, 0], ...texts.map((_, index) => (index === 0 ? [1, 0] : [1, 1]))]),
    );
    const better = await rank(
      [typed('an-editorial', 'editorial'), typed('an-article', 'article')],
      'a passage',
      stubOllama(embed),
      settings,
      new AbortController(),
    );
    expect(better.ordered.map((entry) => entry.record.id)).toEqual(['an-editorial', 'an-article']);
  });

  it('still sinks a dataset that matches better than the article it accompanies', async () => {
    // The contrast with the editorial case above: at 0.5 a dataset does not
    // win on a 0.29 relevance advantage, because supplementary material is
    // rarely what someone writing prose is looking for.
    const embed = vi.fn<OllamaClient['embed']>((_model, [, ...texts]: readonly string[]) =>
      Promise.resolve([[1, 0], ...texts.map((_, index) => (index === 0 ? [1, 0] : [1, 1]))]),
    );

    const { ordered } = await rank(
      [typed('the-dataset', 'dataset'), typed('the-paper', 'article')],
      'a passage',
      stubOllama(embed),
      settings,
      new AbortController(),
    );

    expect(ordered.map((entry) => entry.record.id)).toEqual(['the-paper', 'the-dataset']);
  });

  it('does not demote a preprint — bioRxiv and medRxiv are requested sources', async () => {
    // ADR-029 is explicit that a preprint is labelled, not demoted. Two of the
    // four enabled sources return nothing else.
    const { ordered } = await rank(
      [typed('a-preprint', 'preprint'), typed('an-article', 'article')],
      'a passage',
      tiedRelevance(),
      settings,
      new AbortController(),
    );

    expect(ordered.map((entry) => entry.record.id)).toEqual(['a-preprint', 'an-article']);
  });

  it('does not demote a record whose type simply is not known', async () => {
    // `other` is the fallback for an absent type from both Crossref and
    // OpenAlex. Penalising it would punish thin metadata rather than
    // supplementary material.
    const { ordered } = await rank(
      [typed('untyped', 'other'), typed('an-article', 'article')],
      'a passage',
      tiedRelevance(),
      settings,
      new AbortController(),
    );

    expect(ordered.map((entry) => entry.record.id)).toEqual(['untyped', 'an-article']);
  });

  it('does not hide a demoted record — a strongly matching dataset still surfaces', async () => {
    // Demotion, never a filter: a user searching for a dataset on purpose must
    // still be able to find one.
    const embed = vi.fn<OllamaClient['embed']>((_model, [, ...texts]: readonly string[]) =>
      Promise.resolve([[1, 0], ...texts.map((_, index) => (index === 0 ? [1, 0] : [0, 1]))]),
    );

    const { ordered } = await rank(
      [typed('exact-match-dataset', 'dataset'), typed('unrelated-article', 'article')],
      'a passage',
      stubOllama(embed),
      settings,
      new AbortController(),
    );

    expect(ordered.map((entry) => entry.record.id)).toEqual([
      'exact-match-dataset',
      'unrelated-article',
    ]);
  });

  it('demotes regardless of the citation weight, including when it is off', async () => {
    const { ordered } = await rank(
      [typed('figshare-deposit', 'dataset'), typed('the-paper', 'article')],
      'a passage',
      tiedRelevance(),
      { ...settings, litCitationImpactWeight: 0 },
      new AbortController(),
    );

    expect(ordered.map((entry) => entry.record.id)).toEqual(['the-paper', 'figshare-deposit']);
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
      cached.failedSources,
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
