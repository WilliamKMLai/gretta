/** Recent-searches list tests (DECISIONS.md ADR-028). */
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import type { AssessedRecord } from '../../types/literature';
import { useSettingsStore } from '../settings';
import { cacheKey, hashPassage, writeCache } from './cache';
import { LiteratureHistoryList } from './LiteratureHistoryList';
import { useLiteratureStore } from './literature.store';

const initial = useLiteratureStore.getState();
const initialSettings = useSettingsStore.getState();

function wrap(children: ReactNode): ReactElement {
  return <FluentProvider theme={webLightTheme}>{children}</FluentProvider>;
}

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
      abstract: null,
      type: 'article',
      url: null,
      discoveredVia: 'pubmed',
    },
    signals: { openAlex: null, pubmed: null, crossref: null },
    updates: { checked: false, updates: [] },
    relevance: 0.5,
    stance: null,
    tier: 'queued',
  };
}

beforeEach(() => {
  window.localStorage.clear();
  useLiteratureStore.setState(initial, true);
  useSettingsStore.setState(initialSettings, true);
});

describe('LiteratureHistoryList', () => {
  it('renders nothing when there is no cached search', async () => {
    render(wrap(<LiteratureHistoryList />));
    // Let the async listEntries() lookup resolve before asserting.
    await waitFor(() => {
      expect(screen.queryByText(/recent searches/i)).not.toBeInTheDocument();
    });
  });

  it('restores the query and year filter and searches immediately on click', async () => {
    const user = userEvent.setup();
    // Matches the entry's key (sources, fromYear, resultsPerSource) and its
    // passageHash, so the click resolves as a same-passage cache hit — no
    // network client is ever constructed, so the test needs nothing mocked.
    useSettingsStore.setState({
      litEnabled: true,
      litSources: { pubmed: true, biorxiv: false, medrxiv: false, openalex: false },
      litResultsPerSource: 50,
    });
    useLiteratureStore.setState({ passage: 'the selected passage' });

    const cached = [record('a')];
    await writeCache(cacheKey('cats and inflammation', ['pubmed'], 2020, 50), {
      results: cached,
      ranking: 'semantic',
      hiddenCount: 0,
      rankingNote: null,
      sentQueries: [{ source: 'PubMed', query: 'cats and inflammation' }],
      query: 'cats and inflammation',
      sources: ['pubmed'],
      fromYear: 2020,
      resultsPerSource: 50,
      passageHash: hashPassage('the selected passage'),
    });

    render(wrap(<LiteratureHistoryList />));

    const entry = await screen.findByRole('button', { name: /cats and inflammation/i });
    expect(screen.getByText(/recent searches \(1\)/i)).toBeInTheDocument();

    await user.click(entry);

    await waitFor(() => {
      expect(useLiteratureStore.getState().phase).toBe('done');
    });
    const state = useLiteratureStore.getState();
    expect(state.draft).toBe('cats and inflammation');
    expect(state.fromYear).toBe(2020);
    expect(state.results).toEqual(cached);
  });
});
