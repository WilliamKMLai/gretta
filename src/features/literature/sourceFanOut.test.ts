/**
 * Fan-out tests (DECISIONS.md ADR-032).
 *
 * The ordering case is the one that matters most and is the least obvious. The
 * groups array is not just a bag of results: `mergeRecords` falls back to
 * first-wins when neither of two duplicates carries an abstract, and
 * `rankByRelevance` sorts stably, so source order is the final tie-break in the
 * ranked list a user reads. If concurrency let completion order leak in, the
 * ranking would vary with network weather — a defect that reproduces
 * intermittently and looks like nothing at all.
 */
import { approveQuery } from '../../services/literature';
import type { ApprovedQuery, LiteratureClientConfig } from '../../services/literature';
import type { LiteratureRecord } from '../../types/literature';
import { buildSourceDescriptors, failureMessage, fanOut } from './sourceFanOut';

function record(id: string): LiteratureRecord {
  return {
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
  };
}

/** Resolves after `ms`, so completion order can be made to disagree with input order. */
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) =>
    setTimeout(() => {
      resolve(value);
    }, ms),
  );
}

function approved(text: string): ApprovedQuery {
  const approval = approveQuery(text);
  if (!approval.ok) throw new Error('fixture query was rejected');
  return approval.query;
}

const shared: LiteratureClientConfig = { contactEmail: '', apiKey: '' };
const allSources = { pubmed: true, biorxiv: true, medrxiv: true, openalex: true };

describe('fanOut', () => {
  it('returns groups in descriptor order even when they finish in the reverse', async () => {
    const result = await fanOut([
      { source: 'PubMed', query: 'q', run: () => after(30, { records: [record('pm')] }) },
      { source: 'bioRxiv', query: 'q', run: () => after(15, { records: [record('bio')] }) },
      { source: 'OpenAlex', query: 'q', run: () => after(0, { records: [record('oa')] }) },
    ]);

    expect(result.groups.map((group) => group[0]?.id)).toEqual(['pm', 'bio', 'oa']);
    expect(result.sent.map((entry) => entry.source)).toEqual(['PubMed', 'bioRxiv', 'OpenAlex']);
  });

  it('runs the sources concurrently rather than one after another', async () => {
    const started = new Date().getTime();
    await fanOut(
      ['a', 'b', 'c', 'd'].map((id) => ({
        source: id,
        query: 'q',
        run: () => after(40, { records: [record(id)] }),
      })),
    );

    // Four 40ms sources: ~40ms concurrent, ~160ms sequential. 120 separates
    // the two without being tight enough to flake on a loaded machine.
    expect(new Date().getTime() - started).toBeLessThan(120);
  });

  it('isolates a failing source to its own empty group and a named entry', async () => {
    const result = await fanOut([
      { source: 'PubMed', query: 'q', run: () => Promise.reject(new Error('HTTP 500')) },
      { source: 'OpenAlex', query: 'q', run: () => Promise.resolve({ records: [record('oa')] }) },
    ]);

    expect(result.groups).toEqual([[], [record('oa')]]);
    expect(result.failed).toEqual([{ source: 'PubMed', message: 'HTTP 500' }]);
    expect(result.attempted).toBe(2);
  });

  it('still discloses a source that was asked and did not answer', async () => {
    // ADR-028 promises a record of what was transmitted, not of what came
    // back. The request went out either way.
    const result = await fanOut([
      { source: 'PubMed', query: 'boltzgen', run: () => Promise.reject(new Error('nope')) },
    ]);

    expect(result.sent).toEqual([{ source: 'PubMed', query: 'boltzgen', note: undefined }]);
  });

  it('reports every source failing without throwing, leaving the verdict to the caller', async () => {
    const result = await fanOut([
      { source: 'PubMed', query: 'q', run: () => Promise.reject(new Error('down')) },
      { source: 'OpenAlex', query: 'q', run: () => Promise.reject(new Error('down')) },
    ]);

    expect(result.failed).toHaveLength(2);
    expect(result.failed.length).toBe(result.attempted);
    expect(result.groups).toEqual([[], []]);
  });

  it('merges the MEDLINE map that only PubMed contributes', async () => {
    const result = await fanOut([
      {
        source: 'PubMed',
        query: 'q',
        run: () =>
          Promise.resolve({
            records: [record('pm')],
            medlineIndexed: new Map([['123', true]]),
          }),
      },
      { source: 'OpenAlex', query: 'q', run: () => Promise.resolve({ records: [record('oa')] }) },
    ]);

    expect([...result.medline]).toEqual([['123', true]]);
  });
});

describe('failureMessage', () => {
  it('carries a real message through, so the pane can say what went wrong', () => {
    expect(failureMessage(new Error('HTTP 429'))).toBe('HTTP 429');
  });

  it('falls back rather than rendering an empty parenthesis', () => {
    expect(failureMessage(new Error(''))).toBe('The request failed.');
    expect(failureMessage('a bare string')).toBe('The request failed.');
    expect(failureMessage(undefined)).toBe('The request failed.');
  });
});

describe('buildSourceDescriptors', () => {
  it('builds them in the ADR-031 order, PubMed first', () => {
    const descriptors = buildSourceDescriptors(
      approved('boltzgen'),
      { litSources: allSources, litResultsPerSource: 20 },
      shared,
      null,
      new AbortController().signal,
    );

    expect(descriptors.map((descriptor) => descriptor.source)).toEqual([
      'PubMed',
      'bioRxiv',
      'medRxiv',
      'OpenAlex',
    ]);
  });

  it('includes only the enabled sources, keeping the relative order', () => {
    const descriptors = buildSourceDescriptors(
      approved('boltzgen'),
      {
        litSources: { pubmed: false, biorxiv: false, medrxiv: true, openalex: true },
        litResultsPerSource: 20,
      },
      shared,
      null,
      new AbortController().signal,
    );

    expect(descriptors.map((descriptor) => descriptor.source)).toEqual(['medRxiv', 'OpenAlex']);
  });

  it('produces nothing to run when every source is off', () => {
    expect(
      buildSourceDescriptors(
        approved('boltzgen'),
        {
          litSources: { pubmed: false, biorxiv: false, medrxiv: false, openalex: false },
          litResultsPerSource: 20,
        },
        shared,
        null,
        new AbortController().signal,
      ),
    ).toEqual([]);
  });

  it('does not touch the network merely by being built', () => {
    // The thunks are unevaluated until `fanOut` calls them, which is what lets
    // the caller check "is anything enabled?" before anything is transmitted.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    buildSourceDescriptors(
      approved('boltzgen'),
      { litSources: allSources, litResultsPerSource: 20 },
      shared,
      null,
      new AbortController().signal,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
