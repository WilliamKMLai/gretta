/**
 * `search()` always searches fresh (DECISIONS.md ADR-028). User-reported:
 * changing an Advanced parameter that doesn't affect the cache key (e.g.
 * citation impact weight) and pressing Search still showed the old results,
 * because a matching cache entry short-circuited the network. Pressing
 * Search is a deliberate "search now," never a maybe-cached lookup — that
 * fast path belongs only to `reuseSearch` (`LiteratureHistoryList`).
 *
 * The cancel cases below guard the half of that feature that is invisible
 * until it goes wrong. Aborting a signal does not unwind the promises already
 * awaiting on it, so a cancelled run keeps executing to completion; without
 * the `isCurrent` guard it eventually calls `setResults` and the search the
 * user stopped paints over the one they wanted.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { setServices } from '../../app/services';
import type { OllamaClient } from '../../services/ollama';
import type { AssessedRecord, LiteratureRecord } from '../../types/literature';
import { useSettingsStore } from '../settings';
import { cacheKey, hashPassage, listEntries, writeCache } from './cache';
import { useLiteratureStore } from './literature.store';
import { useLiteratureSearch } from './useLiteratureSearch';

const pubmedSpies = vi.hoisted(() => ({ searchDetailed: vi.fn() }));
const openAlexSpies = vi.hoisted(() => ({ search: vi.fn(), enrich: vi.fn() }));
const crossrefSpies = vi.hoisted(() => ({ searchPreprints: vi.fn(), lookupUpdates: vi.fn() }));

vi.mock('../../services/literature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/literature')>();
  return {
    ...actual,
    createPubMedClient: () => ({
      id: 'pubmed',
      search: vi.fn(),
      searchDetailed: pubmedSpies.searchDetailed,
    }),
    createOpenAlexClient: () => ({
      id: 'openalex',
      search: openAlexSpies.search,
      enrich: openAlexSpies.enrich,
    }),
    createCrossrefClient: () => ({
      id: 'crossref',
      search: vi.fn(),
      searchPreprints: crossrefSpies.searchPreprints,
      lookupUpdates: crossrefSpies.lookupUpdates,
    }),
  };
});

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

const freshRecord: LiteratureRecord = {
  id: 'fresh-1',
  doi: '10.1/fresh',
  pmid: null,
  arxivId: null,
  openAlexId: null,
  title: 'Fresh Paper',
  authors: [],
  containerTitle: null,
  issued: null,
  abstract: 'fresh abstract',
  type: 'article',
  url: null,
  discoveredVia: 'pubmed',
};

/** What `searchDetailed` resolves with, so a pending one can be typed. */
interface PubMedDetailed {
  records: LiteratureRecord[];
  medlineIndexed: Map<string, boolean>;
}

/** Resolves only when the test says so, so a run can be cancelled mid-flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Turns on exactly one source, so one deferred promise stalls the whole run. */
function pubmedOnly(): void {
  useSettingsStore.setState({
    litEnabled: true,
    litSources: { pubmed: true, biorxiv: false, medrxiv: false, openalex: false },
    litVerification: false,
    litResultsPerSource: 20,
  });
  useLiteratureStore.setState({ draft: 'boltzgen', passage: 'the selected passage' });
}

const staleEntry: AssessedRecord = {
  record: { ...freshRecord, id: 'stale-1', title: 'Stale Cached Paper' },
  signals: { openAlex: null, pubmed: null, crossref: null },
  updates: { checked: false, updates: [] },
  relevance: 0.5,
  stance: null,
  tier: 'queued',
};

const initialSettings = useSettingsStore.getState();
const initialLiterature = useLiteratureStore.getState();

beforeEach(() => {
  window.localStorage.clear();
  useSettingsStore.setState(initialSettings, true);
  useLiteratureStore.setState(initialLiterature, true);
  pubmedSpies.searchDetailed.mockReset();
  openAlexSpies.search.mockReset();
  openAlexSpies.enrich.mockReset().mockResolvedValue(new Map());
  crossrefSpies.searchPreprints.mockReset();
  crossrefSpies.lookupUpdates.mockReset().mockResolvedValue(new Map());
  setServices({ ollama: stubOllama((_model, input) => Promise.resolve(input.map(() => [1, 0]))) });
});

describe('useLiteratureSearch().search', () => {
  it('performs a fresh search even when a matching cache entry — same query, sources, filters, and passage — already exists', async () => {
    useSettingsStore.setState({
      litEnabled: true,
      litSources: { pubmed: true, biorxiv: false, medrxiv: false, openalex: false },
      litResultsPerSource: 20,
    });
    useLiteratureStore.setState({ draft: 'boltzgen', passage: 'the selected passage' });

    await writeCache(cacheKey('boltzgen', ['pubmed'], null, 20), {
      results: [staleEntry],
      ranking: 'semantic',
      hiddenCount: 0,
      rankingNote: null,
      sentQueries: [{ source: 'PubMed', query: 'boltzgen' }],
      query: 'boltzgen',
      sources: ['pubmed'],
      fromYear: null,
      resultsPerSource: 20,
      passageHash: hashPassage('the selected passage'),
    });

    pubmedSpies.searchDetailed.mockResolvedValue({
      records: [freshRecord],
      medlineIndexed: new Map(),
    });

    const { result } = renderHook(() => useLiteratureSearch());
    await act(async () => {
      await result.current.search();
    });

    expect(pubmedSpies.searchDetailed).toHaveBeenCalledTimes(1);
    const state = useLiteratureStore.getState();
    expect(state.phase).toBe('done');
    expect(state.results.map((entry) => entry.record.id)).toEqual(['fresh-1']);
  });
});

describe('useLiteratureSearch().search partial failure', () => {
  /** PubMed plus OpenAlex, so one can fail while the other answers. */
  function twoSources(overrides: Record<string, unknown> = {}): void {
    useSettingsStore.setState({
      litEnabled: true,
      litSources: { pubmed: true, biorxiv: false, medrxiv: false, openalex: true },
      litVerification: false,
      litResultsPerSource: 20,
      ...overrides,
    });
    useLiteratureStore.setState({ draft: 'boltzgen', passage: 'the selected passage' });
  }

  const openAlexRecord: LiteratureRecord = {
    ...freshRecord,
    id: 'oa-1',
    doi: '10.1/openalex',
    title: 'OpenAlex Paper',
    discoveredVia: 'openalex',
  };

  it('keeps the results from sources that answered and names the one that did not', async () => {
    twoSources();
    pubmedSpies.searchDetailed.mockRejectedValue(new Error('HTTP 500'));
    openAlexSpies.search.mockResolvedValue([openAlexRecord]);

    const { result } = renderHook(() => useLiteratureSearch());
    await act(async () => {
      await result.current.search();
    });

    const state = useLiteratureStore.getState();
    expect(state.results.map((entry) => entry.record.id)).toEqual(['oa-1']);
    expect(state.failedSources).toEqual([{ source: 'PubMed', message: 'HTTP 500' }]);
    // A warning, not an error — there are real results on screen (ADR-032).
    expect(state.error).toBeNull();
    expect(state.phase).toBe('done');
  });

  it('raises a real error only when every source fails', async () => {
    twoSources();
    pubmedSpies.searchDetailed.mockRejectedValue(new Error('HTTP 500'));
    openAlexSpies.search.mockRejectedValue(new Error('timed out'));

    const { result } = renderHook(() => useLiteratureSearch());
    await act(async () => {
      await result.current.search();
    });

    const state = useLiteratureStore.getState();
    expect(state.phase).toBe('error');
    expect(state.error).toContain('PubMed: HTTP 500');
    expect(state.error).toContain('OpenAlex: timed out');
  });

  it('leaves the retraction check unchecked when Crossref fails, rather than clean', async () => {
    // ADR-029: "not checked" and "checked, nothing found" are different
    // claims. Collapsing the first into the second is how a retracted paper
    // gets presented as clean, which is the failure this whole feature exists
    // to prevent.
    twoSources({ litVerification: true });
    pubmedSpies.searchDetailed.mockResolvedValue({
      records: [freshRecord],
      medlineIndexed: new Map(),
    });
    openAlexSpies.search.mockResolvedValue([]);
    crossrefSpies.lookupUpdates.mockRejectedValue(new Error('Crossref is down'));

    const { result } = renderHook(() => useLiteratureSearch());
    await act(async () => {
      await result.current.search();
    });

    const state = useLiteratureStore.getState();
    expect(state.results[0]?.updates).toEqual({ checked: false, updates: [] });
    // And it must not assert Crossref registration off the back of a lookup
    // that never came back.
    expect(state.results[0]?.signals.crossref).toBeNull();
    expect(state.failedSources.map((entry) => entry.source)).toContain(
      'Crossref (retraction check)',
    );
    expect(state.error).toBeNull();
  });

  it('records the failure on the cached entry, so reusing it warns too', async () => {
    twoSources();
    pubmedSpies.searchDetailed.mockRejectedValue(new Error('HTTP 500'));
    openAlexSpies.search.mockResolvedValue([openAlexRecord]);

    const { result } = renderHook(() => useLiteratureSearch());
    await act(async () => {
      await result.current.search();
    });

    const entries = await listEntries();
    expect(entries[0]?.failedSources).toEqual([{ source: 'PubMed', message: 'HTTP 500' }]);
  });
});

describe('useLiteratureSearch().cancel', () => {
  it('returns to idle silently and drops the cancelled run when it finally resolves', async () => {
    pubmedOnly();
    const pending = deferred<PubMedDetailed>();
    pubmedSpies.searchDetailed.mockReturnValue(pending.promise);

    const { result } = renderHook(() => useLiteratureSearch());
    let run!: Promise<void>;
    act(() => {
      run = result.current.search();
    });
    await waitFor(() => {
      expect(useLiteratureStore.getState().phase).toBe('searching');
    });

    act(() => {
      result.current.cancel();
    });
    // A user-initiated cancel is not an error, so no banner and no `error`
    // phase — the two are the same thing to the person reading the pane.
    expect(useLiteratureStore.getState().phase).toBe('idle');
    expect(useLiteratureStore.getState().error).toBeNull();

    // The abort does not stop the already-issued request from settling.
    await act(async () => {
      pending.resolve({ records: [freshRecord], medlineIndexed: new Map() });
      await run;
    });

    const state = useLiteratureStore.getState();
    expect(state.phase).toBe('idle');
    expect(state.results).toEqual([]);
    expect(state.error).toBeNull();
  });

  it('shows only the second search when one is cancelled and another started', async () => {
    pubmedOnly();
    const cancelledRun = deferred<PubMedDetailed>();
    pubmedSpies.searchDetailed
      .mockReturnValueOnce(cancelledRun.promise)
      .mockResolvedValue({ records: [freshRecord], medlineIndexed: new Map() });

    const { result } = renderHook(() => useLiteratureSearch());
    let first!: Promise<void>;
    act(() => {
      first = result.current.search();
    });
    act(() => {
      result.current.cancel();
    });
    await act(async () => {
      await result.current.search();
    });

    expect(useLiteratureStore.getState().results.map((entry) => entry.record.id)).toEqual([
      'fresh-1',
    ]);

    // The cancelled run lands last and must not win on that account.
    await act(async () => {
      cancelledRun.resolve({
        records: [{ ...freshRecord, id: 'cancelled-1', doi: '10.1/cancelled' }],
        medlineIndexed: new Map(),
      });
      await first;
    });

    const state = useLiteratureStore.getState();
    expect(state.results.map((entry) => entry.record.id)).toEqual(['fresh-1']);
    expect(state.phase).toBe('done');
    expect(state.error).toBeNull();
  });

  it('does not write a cancelled search into the recent-searches cache', async () => {
    pubmedOnly();
    const pending = deferred<PubMedDetailed>();
    pubmedSpies.searchDetailed.mockReturnValue(pending.promise);

    const { result } = renderHook(() => useLiteratureSearch());
    let run!: Promise<void>;
    act(() => {
      run = result.current.search();
    });
    act(() => {
      result.current.cancel();
    });
    await act(async () => {
      pending.resolve({ records: [freshRecord], medlineIndexed: new Map() });
      await run;
    });

    expect(await listEntries()).toEqual([]);
  });
});
