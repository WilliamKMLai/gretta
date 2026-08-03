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
  createPubMedClient,
  describeCredibility,
  embeddableText,
  rankByOverlap,
  queryText,
  rankByRelevance,
  verificationStatus,
} from '../../services/literature';
import type { AssessedRecord, CredibilitySignals, LiteratureRecord } from '../../types/literature';
import { useSettingsStore } from '../settings';
import { useLiteratureStore, type RankingMode, type SourceQuery } from './literature.store';
import { DRAFT_QUERY_SYSTEM, buildDraftPrompt, extractDraftedQuery } from './draftQuery';

function emptySignals(): CredibilitySignals {
  return { openAlex: null, pubmed: null, crossref: null };
}

/** Deduplicates across sources by DOI, preferring the record with an abstract. */
function mergeRecords(groups: readonly LiteratureRecord[][]): LiteratureRecord[] {
  const byKey = new Map<string, LiteratureRecord>();
  for (const group of groups) {
    for (const record of group) {
      const key = record.doi?.toLowerCase() ?? record.id;
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, record);
        continue;
      }
      // PubMed carries abstracts far more often than Crossref; when both have
      // the same paper, keep whichever actually has text to embed.
      if (existing.abstract === null && record.abstract !== null) {
        byKey.set(key, { ...record, doi: record.doi ?? existing.doi });
      }
    }
  }
  return [...byKey.values()];
}

export interface UseLiteratureSearch {
  captureAndDraft: () => Promise<void>;
  search: () => Promise<void>;
  busy: boolean;
}

export function useLiteratureSearch(): UseLiteratureSearch {
  const settings = useSettingsStore();
  const store = useLiteratureStore();
  const { setPassage, setDraft, setPhase, setError, setResults } = store;

  /** Steps 1 and 2. Nothing here touches the network. */
  const captureAndDraft = useCallback(async (): Promise<void> => {
    const { office, ollama } = getServices();
    setPhase('drafting');
    setError(null);

    try {
      const selection = await office.getSelection();
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

      const controller = new AbortController();
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
      // Deliberately NOT expanded here. The drafting prompt now quotes names
      // itself, and stacking every spelling on top made queries long enough to
      // match nothing against APIs that AND their terms. Expansion is offered
      // as an explicit action in the pane, for when a name is missed.
      setDraft(extractDraftedQuery(text));
      setPhase('ready');
    } catch {
      // A failed draft is not a failed feature — typing a query still works.
      setDraft('');
      setPhase('ready');
    }
  }, [settings, setPassage, setDraft, setPhase, setError]);

  /** Steps 4 and 5. The first and only outbound traffic. */
  const search = useCallback(async (): Promise<void> => {
    const approval = approveQuery(useLiteratureStore.getState().draft);
    if (!approval.ok) {
      setError(approval.message);
      return;
    }

    const { ollama } = getServices();
    const { passage, fromYear } = useLiteratureStore.getState();
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
    const controller = new AbortController();

    try {
      const groups: LiteratureRecord[][] = [];
      const medline = new Map<string, boolean>();
      /** What each source actually received, for the disclosure in the pane. */
      const sent: SourceQuery[] = [];

      // PubMed first: it is the primary source, free, account-free, and has the
      // best abstract coverage of any of them (ADR-031).
      if (settings.litSources.pubmed) {
        const result = await createPubMedClient(shared).searchDetailed(
          approval.query,
          perSource,
          controller.signal,
        );
        groups.push(result.records);
        for (const [pmid, indexed] of result.medlineIndexed) medline.set(pmid, indexed);
        sent.push({
          source: 'PubMed',
          query: queryText(approval.query),
          note: 'Retried with terms OR-ed if the strict query matched nothing.',
        });
      }

      const wantsPreprints = settings.litSources.biorxiv || settings.litSources.medrxiv;
      const crossrefSearch = wantsPreprints ? createCrossrefClient(shared) : null;

      for (const server of ['biorxiv', 'medrxiv'] as const) {
        if (crossrefSearch === null || !settings.litSources[server]) continue;
        groups.push(
          await crossrefSearch.searchPreprints(
            approval.query,
            perSource,
            server,
            controller.signal,
          ),
        );
        sent.push({
          source: server === 'biorxiv' ? 'bioRxiv' : 'medRxiv',
          query: queryText(approval.query),
          note: 'Sent to Crossref, filtered to preprints from this server — it publishes no search API of its own.',
        });
      }

      const openAlexClient = settings.litSources.openalex ? createOpenAlexClient(shared) : null;
      if (openAlexClient !== null) {
        groups.push(
          await openAlexClient.search(approval.query, perSource, fromYear, controller.signal),
        );
        sent.push({ source: 'OpenAlex', query: queryText(approval.query) });
      }

      if (groups.length === 0) {
        setError('No source is turned on. Enable at least one under Settings → Literature.');
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
        setResults([], 'source-order', 0, null, sent);
        return;
      }

      const dois = records.map((record) => record.doi).filter((doi): doi is string => doi !== null);

      // Enrichment. Absent when the toggle is off, which the badges render as
      // "not checked" rather than as absent signals (ADR-029).
      const enrichment =
        openAlexClient === null ? null : await openAlexClient.enrich(dois, controller.signal);

      const crossref = settings.litVerification ? createCrossrefClient(shared) : null;
      if (crossref !== null) {
        sent.push({
          source: 'Crossref',
          query: `${String(dois.length)} DOIs, for retraction notices only`,
        });
      }

      // Retractions. Batched — one request per 20 DOIs — because checking them
      // serially took twelve seconds for ten results, and ADR-029 will not let
      // the check happen lazily after the list has painted.
      const updates =
        crossref === null ? null : await crossref.lookupUpdates(dois, controller.signal);

      const assessed: AssessedRecord[] = records.map((record) => {
        const key = record.doi?.toLowerCase() ?? '';
        const openAlex = enrichment?.get(key) ?? null;
        const signals = emptySignals();
        if (openAlex !== null) signals.openAlex = openAlex.signals;
        if (record.pmid !== null && medline.size > 0) {
          signals.pubmed = { inPubMed: true, medlineIndexed: medline.get(record.pmid) ?? null };
        }
        if (crossref !== null && record.doi !== null) {
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

      const { ordered, ranking, note } = await rank(
        assessed,
        passage,
        ollama,
        settings,
        controller,
      );
      const hidden = ordered.filter(
        (entry) => verificationStatus(entry.signals) === 'limited',
      ).length;

      setResults(ordered, ranking, hidden, note, sent);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The search could not be completed.');
    }
  }, [settings, setPhase, setError, setResults]);

  return {
    captureAndDraft,
    search,
    busy: store.phase === 'drafting' || store.phase === 'searching',
  };
}

/**
 * Ranks by embeddings when they are available, by lexical overlap when they are
 * not, and reports *why* it fell back.
 *
 * The reason used to be swallowed by a bare `catch`, so a user whose embedding
 * model was simply set to something they had not pulled was told "no embedding
 * model available" — true in effect, useless as a diagnosis, and easy to read
 * as a bug in the feature rather than a setting to change. The failure is
 * expected and survivable; being vague about it is not.
 */
async function rank(
  assessed: readonly AssessedRecord[],
  passage: string,
  ollama: ReturnType<typeof getServices>['ollama'],
  settings: { defaultEmbeddingModel: string },
  controller: AbortController,
): Promise<{ ordered: AssessedRecord[]; ranking: RankingMode; note: string | null }> {
  const texts = assessed.map((entry) => embeddableText(entry.record));
  const model = settings.defaultEmbeddingModel;
  let note: string;

  try {
    const vectors = await ollama.embed(model, [passage, ...texts], controller.signal);
    const [passageVector, ...candidateVectors] = vectors;

    if (passageVector !== undefined && candidateVectors.length === assessed.length) {
      const ranked = rankByRelevance(
        passageVector,
        assessed.map((entry, index) => ({
          payload: entry,
          embedding: candidateVectors[index] ?? [],
        })),
      );
      return {
        ordered: ranked.map((entry) => ({ ...entry.payload, relevance: entry.relevance })),
        ranking: 'semantic',
        note: null,
      };
    }
    note = `${model} returned an unexpected number of vectors.`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    note = `Could not embed with ${model} — ${detail} Check the embedding model under Settings → Connection; it must be an embedding model you have pulled.`;
  }

  const ranked = rankByOverlap(
    passage,
    assessed.map((entry, index) => ({ payload: entry, text: texts[index] ?? '' })),
  );
  return {
    ordered: ranked.map((entry) => ({ ...entry.payload, relevance: entry.relevance })),
    ranking: 'lexical',
    note,
  };
}

export { describeCredibility };
