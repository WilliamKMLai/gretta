/**
 * `search()` always searches fresh (DECISIONS.md ADR-028). User-reported:
 * changing an Advanced parameter that doesn't affect the cache key (e.g.
 * citation impact weight) and pressing Search still showed the old results,
 * because a matching cache entry short-circuited the network. Pressing
 * Search is a deliberate "search now," never a maybe-cached lookup — that
 * fast path belongs only to `reuseSearch` (`LiteratureHistoryList`).
 */
import { act, renderHook } from '@testing-library/react';
import { setServices } from '../../app/services';
import type { OllamaClient } from '../../services/ollama';
import type { AssessedRecord, LiteratureRecord } from '../../types/literature';
import { useSettingsStore } from '../settings';
import { cacheKey, hashPassage, writeCache } from './cache';
import { useLiteratureStore } from './literature.store';
import { useLiteratureSearch } from './useLiteratureSearch';

const pubmedSpies = vi.hoisted(() => ({ searchDetailed: vi.fn() }));

vi.mock('../../services/literature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/literature')>();
  return {
    ...actual,
    createPubMedClient: () => ({
      id: 'pubmed',
      search: vi.fn(),
      searchDetailed: pubmedSpies.searchDetailed,
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
