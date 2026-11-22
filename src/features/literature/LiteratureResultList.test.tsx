/** Citation-number tests: each result gets a stable [n], continuous across
 * the verified and collapsed limited-verification groups. */
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import type { AssessedRecord, CredibilitySignals } from '../../types/literature';
import { useSettingsStore } from '../settings';
import { LiteratureResultList } from './LiteratureResultList';
import { useLiteratureStore } from './literature.store';

const initial = useLiteratureStore.getState();
const initialSettings = useSettingsStore.getState();

function wrap(children: ReactNode): ReactElement {
  return <FluentProvider theme={webLightTheme}>{children}</FluentProvider>;
}

function entry(id: string, signals: CredibilitySignals): AssessedRecord {
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
    signals,
    updates: { checked: false, updates: [] },
    relevance: 0.5,
    stance: null,
    tier: 'queued',
  };
}

const notChecked: CredibilitySignals = { openAlex: null, pubmed: null, crossref: null };
// At least one group present but none vouch for the venue — lands in the
// collapsed "limited verification" group (credibility.ts `verificationStatus`).
const limitedSignals: CredibilitySignals = {
  openAlex: null,
  pubmed: { inPubMed: true, medlineIndexed: false },
  crossref: null,
};
const withCitations: CredibilitySignals = {
  openAlex: {
    venueKnown: true,
    venueInDoaj: null,
    venueIsOa: null,
    venueMeanCitedness: null,
    venueHIndex: null,
    venueApcUsd: null,
    fwci: null,
    citedByPercentileYear: null,
    citedByCount: 1234,
    isParatext: null,
  },
  pubmed: null,
  crossref: null,
};

beforeEach(() => {
  useLiteratureStore.setState(initial, true);
  useSettingsStore.setState(initialSettings, true);
});

describe('LiteratureResultList citation numbers', () => {
  it('numbers verified results 1..n', () => {
    useLiteratureStore.setState({
      results: [entry('a', notChecked), entry('b', notChecked)],
      ranking: 'semantic',
      hiddenCount: 0,
      rankingNote: null,
      sentQueries: [],
    });

    render(wrap(<LiteratureResultList />));

    expect(screen.getByText('[1]')).toBeInTheDocument();
    expect(screen.getByText('[2]')).toBeInTheDocument();
  });

  it('continues numbering into the limited-verification group once expanded', async () => {
    const user = userEvent.setup();
    useLiteratureStore.setState({
      results: [entry('a', notChecked), entry('b', notChecked), entry('c', limitedSignals)],
      ranking: 'semantic',
      hiddenCount: 1,
      rankingNote: null,
      sentQueries: [],
    });

    render(wrap(<LiteratureResultList />));

    expect(screen.getByText('[1]')).toBeInTheDocument();
    expect(screen.getByText('[2]')).toBeInTheDocument();
    expect(screen.queryByText('[3]')).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: /further results with limited verification/i }),
    );

    expect(screen.getByText('[3]')).toBeInTheDocument();
  });
});

describe('LiteratureResultList skipped-checks note', () => {
  it('states every skipped check once, and drops the per-card grey badges', () => {
    useLiteratureStore.setState({
      results: [entry('a', notChecked), entry('b', notChecked)],
      ranking: 'semantic',
      hiddenCount: 0,
      rankingNote: null,
      sentQueries: [],
    });

    render(wrap(<LiteratureResultList />));

    expect(
      screen.getByText('Not checked: retraction/registration · MEDLINE · venue. ', {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Registration not checked')).not.toBeInTheDocument();
    expect(screen.queryByText('MEDLINE not checked')).not.toBeInTheDocument();
    expect(screen.queryByText('Venue not checked')).not.toBeInTheDocument();
  });

  it('only names the checks skipped for every result, not ones only some results lack', () => {
    useLiteratureStore.setState({
      // "a" has no OpenAlex signal; "b" does — so venue isn't skipped for
      // *every* result, and shouldn't be named.
      results: [entry('a', notChecked), entry('b', withCitations)],
      ranking: 'semantic',
      hiddenCount: 0,
      rankingNote: null,
      sentQueries: [],
    });

    render(wrap(<LiteratureResultList />));

    expect(
      screen.getByText(/Not checked: retraction\/registration · MEDLINE\./),
    ).toBeInTheDocument();
  });

  it('still badges a per-record gap the search-wide summary does not cover', () => {
    // "b" has a venue signal, so the summary won't say "venue" — but "a"
    // genuinely lacks one, and that must not become invisible.
    useLiteratureStore.setState({
      results: [entry('a', notChecked), entry('b', withCitations)],
      ranking: 'semantic',
      hiddenCount: 0,
      rankingNote: null,
      sentQueries: [],
    });

    render(wrap(<LiteratureResultList />));

    expect(screen.getByText('Venue not checked')).toBeInTheDocument();
  });
});

describe('LiteratureResultList citation count', () => {
  it('shows the raw citation count once, distinctly from the credibility badges', () => {
    useLiteratureStore.setState({
      results: [entry('a', withCitations)],
      ranking: 'semantic',
      hiddenCount: 0,
      rankingNote: null,
      sentQueries: [],
    });

    render(wrap(<LiteratureResultList />));

    // A single match proves it isn't also duplicated in the generic badge
    // row — getByText throws on more than one match.
    expect(screen.getByText('1,234 citations')).toBeInTheDocument();
  });
});

describe('LiteratureResultList ranking label', () => {
  it('reflects log-scaled citation weighting when enabled and omits it when set to 0', () => {
    useLiteratureStore.setState({
      results: [entry('a', withCitations)],
      ranking: 'semantic',
      hiddenCount: 0,
      rankingNote: null,
      sentQueries: [],
    });

    const view = render(wrap(<LiteratureResultList />));
    expect(
      screen.getByText(/weighted by log-scaled citation count \(OpenAlex, when available\)/),
    ).toBeInTheDocument();
    view.unmount();

    useSettingsStore.setState({ litCitationImpactWeight: 0 });
    render(wrap(<LiteratureResultList />));
    expect(screen.getByText('Ranked against your selection, on this machine.')).toBeInTheDocument();
    expect(screen.queryByText(/log-scaled citation count/)).not.toBeInTheDocument();
  });
});
