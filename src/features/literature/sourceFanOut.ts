/**
 * Querying the enabled sources concurrently, with per-source failure isolation
 * (DECISIONS.md ADR-032).
 *
 * Two properties this file exists to hold, both easy to break by accident:
 *
 * 1. **Order is preserved by construction.** Descriptors are built in the
 *    ADR-031 source order (PubMed first) and results are read back *by index*,
 *    never pushed as they resolve. The order of the groups array is
 *    semantically load-bearing downstream: `mergeRecords` falls back to
 *    first-wins when neither of two duplicates carries an abstract, and
 *    `rankByRelevance` sorts stably, so source order survives as the final
 *    tie-break. Completion order would make both depend on which host happened
 *    to answer first — a non-deterministic ranking, and the kind of defect that
 *    reproduces once in ten runs.
 * 2. **One source failing costs only that source.** A rejection contributes an
 *    empty group and a named entry in `failed`, never an exception that
 *    discards the sources that did answer. Deciding that an all-sources
 *    failure is a real error is the caller's job, not this file's — it is the
 *    only place that knows whether anything else is on screen.
 *
 * Concurrency across these four is fine on rate-limit grounds: the pacing in
 * `etiquette.ts` is per client instance and these are four different hosts.
 * Sequencing *within* a client is untouched.
 */
import {
  createCrossrefClient,
  createOpenAlexClient,
  createPubMedClient,
  queryText,
} from '../../services/literature';
import type { ApprovedQuery, LiteratureClientConfig } from '../../services/literature';
import type { LiteratureRecord } from '../../types/literature';
import type { FailedSource, SourceQuery } from './literature.store';

/** What one source contributes when it answers. */
interface SourceResult {
  records: LiteratureRecord[];
  /** PubMed only: which PMIDs are MEDLINE-indexed. */
  medlineIndexed?: Map<string, boolean>;
}

interface SourceDescriptor extends SourceQuery {
  run: () => Promise<SourceResult>;
}

export interface FanOutResult {
  /** One group per attempted source, in source order. Empty for a failure. */
  groups: LiteratureRecord[][];
  /** What each source was sent, including ones that then failed to answer. */
  sent: SourceQuery[];
  failed: FailedSource[];
  medline: Map<string, boolean>;
  /** How many sources were attempted, so the caller can spot an all-fail. */
  attempted: number;
}

/** The subset of settings that decides which sources run and how. */
export interface FanOutSettings {
  litSources: { pubmed: boolean; biorxiv: boolean; medrxiv: boolean; openalex: boolean };
  litResultsPerSource: number;
}

/**
 * Builds one descriptor per enabled source, in ADR-031 order.
 *
 * Nothing is invoked here — the thunks are called by `fanOut`, so building the
 * list is free of side effects and can be asserted on directly in tests.
 */
export function buildSourceDescriptors(
  query: ApprovedQuery,
  settings: FanOutSettings,
  shared: LiteratureClientConfig,
  fromYear: number | null,
  signal: AbortSignal,
): SourceDescriptor[] {
  const perSource = settings.litResultsPerSource;
  const text = queryText(query);
  const descriptors: SourceDescriptor[] = [];

  // PubMed first: primary source, free, account-free, and the best abstract
  // coverage of any of them (ADR-031).
  if (settings.litSources.pubmed) {
    descriptors.push({
      source: 'PubMed',
      query: text,
      note: 'Retried with terms OR-ed if the strict query matched nothing.',
      run: async () => {
        const result = await createPubMedClient(shared).searchDetailed(query, perSource, signal);
        return { records: result.records, medlineIndexed: result.medlineIndexed };
      },
    });
  }

  for (const server of ['biorxiv', 'medrxiv'] as const) {
    if (!settings.litSources[server]) continue;
    descriptors.push({
      source: server === 'biorxiv' ? 'bioRxiv' : 'medRxiv',
      query: text,
      note: 'Sent to Crossref, filtered to preprints from this server — it publishes no search API of its own.',
      run: async () => ({
        records: await createCrossrefClient(shared).searchPreprints(
          query,
          perSource,
          server,
          signal,
        ),
      }),
    });
  }

  if (settings.litSources.openalex) {
    descriptors.push({
      source: 'OpenAlex',
      query: text,
      run: async () => ({
        records: await createOpenAlexClient(shared).search(query, perSource, fromYear, signal),
      }),
    });
  }

  return descriptors;
}

/** Reduces a thrown value to something worth showing beside a source name. */
export function failureMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message !== '') return reason.message;
  return 'The request failed.';
}

/**
 * Runs every descriptor concurrently and collects the outcomes in input order.
 *
 * `Promise.allSettled` is the whole mechanism: it preserves input order and it
 * does not reject, so the two properties in this file's header fall out of it
 * rather than being maintained by hand.
 */
export async function fanOut(descriptors: readonly SourceDescriptor[]): Promise<FanOutResult> {
  const settled = await Promise.allSettled(descriptors.map((descriptor) => descriptor.run()));

  const groups: LiteratureRecord[][] = [];
  const sent: SourceQuery[] = [];
  const failed: FailedSource[] = [];
  const medline = new Map<string, boolean>();

  descriptors.forEach((descriptor, index) => {
    // Disclosed whether or not it answered: the request went out, and ADR-028
    // promises a record of what was transmitted, not of what came back.
    sent.push({ source: descriptor.source, query: descriptor.query, note: descriptor.note });

    const outcome = settled[index];
    if (outcome === undefined || outcome.status === 'rejected') {
      failed.push({
        source: descriptor.source,
        message: failureMessage(outcome === undefined ? undefined : outcome.reason),
      });
      // An empty group rather than a skipped one, so group count keeps
      // matching descriptor count and index-based reasoning stays valid.
      groups.push([]);
      return;
    }

    groups.push(outcome.value.records);
    for (const [pmid, indexed] of outcome.value.medlineIndexed ?? []) medline.set(pmid, indexed);
  });

  return { groups, sent, failed, medline, attempted: descriptors.length };
}
