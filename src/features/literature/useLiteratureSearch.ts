/**
 * Literature search orchestration (DECISIONS.md ADR-028, ADR-029, ADR-030).
 *
 * The order of operations here is the privacy argument made executable:
 *
 * 1. Capture the passage from the document. Local.
 * 2. Draft a keyword query from it with the user's own Ollama. Local.
 * 3. Stop. The draft sits in the store until the user reads it and presses
 *    Search. This is the only point at which anything is transmitted.
 * 4. Search the enabled sources with that query, and nothing else.
 * 5. Enrich, check retractions, and re-rank — the re-rank against the
 *    *passage*, which never left the machine.
 *
 * Step 3 is why there is no `useEffect` in this file that fires on selection
 * change, and why `search()` takes no arguments it could have derived itself.
 */
import { useCallback } from 'react';
import { getServices } from '../../app/services';
import {
  approveQuery,
  createCrossrefClient,
  createOpenAlexClient,
  describeCredibility,
  queryText,
} from '../../services/literature';
import type { AssessedRecord } from '../../types/literature';
import { useSettingsStore } from '../settings';
import { useLiteratureStore } from './literature.store';
import { DRAFT_QUERY_SYSTEM, buildDraftPrompt, extractDraftedQuery } from './draftQuery';
import { cacheKey, enabledSourceKeys, hashPassage, writeCache } from './cache';
import type { CacheEntry } from './cache';
import { deliverRanked, emptySignals, mergeRecords, resolveCacheHit } from './searchPipeline';
import { abortRun, beginRun, endRun, isCurrent, onlyIfCurrent, wasAborted } from './searchRun';
import { buildSourceDescriptors, failureMessage, fanOut } from './sourceFanOut';

export interface UseLiteratureSearch {
  captureAndDraft: () => Promise<void>;
  /** Always a fresh search, never served from cache — see `reuseSearch`. */
  search: () => Promise<void>;
  /** Restores a "recent searches" entry; the one place a cache hit — instant
   * if the passage still matches, a real re-rank if it doesn't — is wanted. */
  reuseSearch: (entry: CacheEntry) => Promise<void>;
  /**
   * Stops whichever of the three is in flight. Deliberately not an error: a
   * user-initiated cancel returns the pane to `idle` silently, and leaves any
   * results already on screen alone — cancelling a new search is a decision
   * not to replace what is there, not a request to throw it away.
   */
  cancel: () => void;
  busy: boolean;
}

export function useLiteratureSearch(): UseLiteratureSearch {
  const phase = useLiteratureStore((state) => state.phase);

  /**
   * Cancels the run in flight. Phase only — the results, passage and draft
   * already on screen are the state the pane was in before the run started,
   * and returning to that state is what "cancel" means.
   */
  const cancel = useCallback((): void => {
    abortRun();
    useLiteratureStore.getState().setPhase('idle');
  }, []);

  /**
   * Steps 1 and 2. Nothing here touches the network — but the local generation
   * can still take a while on a large model, so it is cancellable too.
   */
  const captureAndDraft = useCallback(async (): Promise<void> => {
    const { office, ollama } = getServices();
    const settings = useSettingsStore.getState();
    const { setPassage, setDraft, setPhase, setError } = useLiteratureStore.getState();
    const controller = beginRun();
    setPhase('drafting');
    setError(null);

    try {
      const selection = await office.getSelection();
      if (!isCurrent(controller)) return;
      const passage = selection.text.trim();
      if (selection.isEmpty || passage === '') {
        setError('Select the passage you want to find literature for, then try again.');
        return;
      }
      setPassage(passage);

      const model = settings.litDraftModel ?? settings.defaultModel;
      if (model === null) {
        // Still usable: the user can type a query themselves.
        setDraft('');
        setPhase('ready');
        return;
      }

      const events = ollama.generate(
        {
          model,
          prompt: buildDraftPrompt(passage),
          system: DRAFT_QUERY_SYSTEM,
          stream: false,
          // Low temperature: a search query is not a place for invention, and a
          // drafter that surprises the user makes the review gate harder to use.
          options: {
            temperature: 0.2,
            top_p: settings.topP,
            top_k: settings.topK,
            num_ctx: settings.contextLength,
          },
        },
        controller.signal,
      );

      let text = '';
      for await (const event of events) {
        if (event.type === 'token') text += event.content;
      }
      if (!isCurrent(controller)) return;
      // Deliberately NOT expanded here. The drafting prompt now quotes names
      // itself, and stacking every spelling on top made queries long enough to
      // match nothing against APIs that AND their terms. Expansion is offered
      // as an explicit action in the pane, for when a name is missed.
      setDraft(extractDraftedQuery(text));
      setPhase('ready');
    } catch (error) {
      // A cancel is not a failure. `cancel()` has already put the pane back to
      // idle, and blanking the draft the user just asked to stop writing would
      // be a strange way to honour that.
      if (wasAborted(error, controller)) return;
      // A failed draft is not a failed feature — typing a query still works.
      setDraft('');
      setPhase('ready');
    } finally {
      endRun(controller);
    }
  }, []);

  /** Steps 4 and 5. The first and only outbound traffic. */
  const search = useCallback(async (): Promise<void> => {
    const { draft, passage, fromYear, setPhase, setError, setResults } =
      useLiteratureStore.getState();
    const approval = approveQuery(draft);
    if (!approval.ok) {
      setError(approval.message);
      return;
    }

    const settings = useSettingsStore.getState();
    const { ollama } = getServices();
    setPhase('searching');
    setError(null);

    const shared = { contactEmail: settings.litContactEmail, apiKey: settings.litOpenAlexKey };
    /*
     * Candidates fetched per source before ranking trims the list. Local
     * re-ranking is precision over a pool and cannot improve recall — if the
     * right paper is not among the candidates, no ordering produces it — so
     * this trades breadth against latency and embedding cost, and is a setting
     * rather than a constant because the right value depends on the field.
     */
    const perSource = settings.litResultsPerSource;
    const controller = beginRun();
    // Every write from here on goes through this, not `setResults` directly:
    // aborting the signal does not unwind the awaits already holding it, so a
    // cancelled run keeps running to completion and would otherwise paint.
    const deliver = onlyIfCurrent(controller, setResults);

    const enabledSources = enabledSourceKeys(
      settings.litSources as unknown as Record<string, boolean>,
    );
    const cacheEntryKey = cacheKey(queryText(approval.query), enabledSources, fromYear, perSource);

    try {
      const descriptors = buildSourceDescriptors(
        approval.query,
        settings,
        shared,
        fromYear,
        controller.signal,
      );
      if (descriptors.length === 0) {
        setError('No source is turned on. Enable at least one under Settings → Literature.');
        return;
      }

      // Four hosts, four concurrent requests, wall-clock ≈ the slowest rather
      // than the sum (ADR-032). Failures are isolated per source here; whether
      // they add up to a real error is decided below, where it is known what
      // else there is to show.
      const { groups, sent, failed, medline, attempted } = await fanOut(descriptors);

      if (failed.length === attempted) {
        setError(
          `No source could be reached. ${failed
            .map((entry) => `${entry.source}: ${entry.message}`)
            .join(' ')}`,
        );
        return;
      }

      const withinRange =
        fromYear === null
          ? groups
          : groups.map((group) =>
              // Applied client-side for sources that cannot bound by date in the
              // query. An undated record is kept rather than dropped: absence of
              // a date is not evidence of age.
              group.filter((record) => record.issued === null || record.issued.year >= fromYear),
            );

      const records = mergeRecords(withinRange);
      if (records.length === 0) {
        deliver([], 'source-order', 0, null, sent, failed);
        return;
      }

      const dois = records.map((record) => record.doi).filter((doi): doi is string => doi !== null);

      // Enrichment. Absent when the toggle is off, which the badges render as
      // "not checked" rather than as absent signals (ADR-029).
      const openAlexClient = settings.litSources.openalex ? createOpenAlexClient(shared) : null;
      const crossref = settings.litVerification ? createCrossrefClient(shared) : null;
      if (crossref !== null) {
        sent.push({
          source: 'Crossref',
          query: `${String(dois.length)} DOIs, for retraction notices only`,
        });
      }

      /*
       * Independent, both keyed on the same DOI list, so they run together
       * under the same isolation as the source fan-out (ADR-032). Retractions
       * are batched — one request per 20 DOIs — because checking them serially
       * took twelve seconds for ten results, and ADR-029 will not let the check
       * happen lazily after the list has painted.
       */
      const [enrichOutcome, updatesOutcome] = await Promise.allSettled([
        openAlexClient?.enrich(dois, controller.signal) ?? Promise.resolve(null),
        crossref?.lookupUpdates(dois, controller.signal) ?? Promise.resolve(null),
      ]);

      const enrichment = enrichOutcome.status === 'fulfilled' ? enrichOutcome.value : null;
      if (enrichOutcome.status === 'rejected') {
        failed.push({
          source: 'OpenAlex (citations and venue details)',
          message: failureMessage(enrichOutcome.reason),
        });
      }

      /*
       * Null on rejection, which flows into `{ checked: false }` below rather
       * than an empty update list. ADR-029 requires the distinction: "not
       * checked" and "checked, nothing found" are different claims, and
       * rendering the first as the second is how a retracted paper gets
       * presented as clean.
       */
      const updates = updatesOutcome.status === 'fulfilled' ? updatesOutcome.value : null;
      if (updatesOutcome.status === 'rejected') {
        failed.push({
          source: 'Crossref (retraction check)',
          message: failureMessage(updatesOutcome.reason),
        });
      }

      const assessed: AssessedRecord[] = records.map((record) => {
        const key = record.doi?.toLowerCase() ?? '';
        const openAlex = enrichment?.get(key) ?? null;
        const signals = emptySignals();
        if (openAlex !== null) signals.openAlex = openAlex.signals;
        if (record.pmid !== null && medline.size > 0) {
          signals.pubmed = { inPubMed: true, medlineIndexed: medline.get(record.pmid) ?? null };
        }
        // `updates`, not `crossref`: the toggle being on says we asked, not
        // that we got an answer. A failed lookup must not assert registration.
        if (updates !== null && record.doi !== null) {
          signals.crossref = {
            registered: true,
            hasDepositedReferences: null,
            memberName: null,
          };
        }
        return {
          record: { ...record, abstract: record.abstract ?? openAlex?.abstract ?? null },
          signals,
          updates: updates?.get(record.doi ?? '') ?? { checked: false, updates: [] },
          relevance: null,
          stance: null,
          tier: 'queued',
        };
      });

      const { ordered, ranking, note, hidden } = await deliverRanked(
        assessed,
        sent,
        failed,
        passage,
        ollama,
        settings,
        controller,
        deliver,
      );
      // A cancelled search is not history: it never reached the screen, so it
      // has no business appearing under "Recent searches" either.
      if (!isCurrent(controller)) return;
      // Best-effort: a full localStorage must not fail a search that already
      // succeeded and is already on screen.
      await writeCache(cacheEntryKey, {
        results: ordered,
        ranking,
        hiddenCount: hidden,
        rankingNote: note,
        sentQueries: sent,
        failedSources: failed,
        query: queryText(approval.query),
        sources: enabledSources,
        fromYear,
        resultsPerSource: perSource,
        passageHash: hashPassage(passage),
      }).catch(() => undefined);
    } catch (error) {
      // Cancelling is a choice, not a fault. Rendering it as a red banner is
      // the `setError(null)` class of bug in reverse: state the user caused,
      // reported back to them as something that went wrong.
      if (wasAborted(error, controller)) return;
      setError(error instanceof Error ? error.message : 'The search could not be completed.');
    } finally {
      endRun(controller);
    }
  }, []);

  const reuseSearch = useCallback(async (entry: CacheEntry): Promise<void> => {
    const { ollama } = getServices();
    const settings = useSettingsStore.getState();
    const { setDraft, setFromYear, setPhase, setError, setResults } = useLiteratureStore.getState();
    setDraft(entry.query);
    setFromYear(entry.fromYear);
    setPhase('searching');
    setError(null);

    // Cancellable for the same reason as `search`: a stored entry whose
    // passage has changed re-ranks, which embeds, which is a real wait.
    const controller = beginRun();
    try {
      const { passage } = useLiteratureStore.getState();
      await resolveCacheHit(
        entry.key,
        entry,
        passage,
        ollama,
        settings,
        controller,
        onlyIfCurrent(controller, setResults),
      );
    } catch (error) {
      if (wasAborted(error, controller)) return;
      setError(error instanceof Error ? error.message : 'The search could not be completed.');
    } finally {
      endRun(controller);
    }
  }, []);

  return {
    captureAndDraft,
    search,
    reuseSearch,
    cancel,
    busy: phase === 'drafting' || phase === 'searching',
  };
}

export { describeCredibility };
