/**
 * Literature search state (ARCHITECTURE.md §8; DECISIONS.md ADR-028, ADR-029).
 *
 * The state machine is shaped by ADR-028's review gate rather than by
 * convenience. A query is *drafted* (locally, from the selected passage), then
 * sits in `draft` where the user can read and edit it, and only a deliberate
 * `search()` transmits anything. There is deliberately no "search as you type",
 * no debounce, and no effect that fires on selection change — each would turn
 * an outbound request into a side effect of moving the cursor.
 *
 * `passage` is kept separately from `draft` because they are different things
 * with different rules: the passage never leaves the machine and is what the
 * local re-ranker embeds; the draft is the only text that is ever transmitted.
 */
import { create } from 'zustand';
import type { AssessedRecord } from '../../types/literature';

export type LiteraturePhase = 'idle' | 'drafting' | 'ready' | 'searching' | 'done' | 'error';

/** How the result list was ordered, so the pane can say which ran (ADR-029). */
export type RankingMode = 'semantic' | 'lexical' | 'source-order';

/**
 * What one source actually received.
 *
 * ADR-028 promised the query field shows the exact bytes transmitted. Sources
 * do not all speak the same dialect — PubMed retries with terms OR-ed, arXiv
 * takes an `all:` prefix, Crossref gets DOIs rather than words — so the honest
 * way to keep that promise while adapting per source is to show what each one
 * was sent, rather than to stop adapting or to stop saying so.
 */
export interface SourceQuery {
  source: string;
  query: string;
  note?: string;
}

export interface LiteratureState {
  phase: LiteraturePhase;
  /** The captured document text. Never transmitted; embedded locally. */
  passage: string;
  /** The exact string that will be sent, shown verbatim and editable. */
  draft: string;
  /**
   * Earliest publication year to accept, or null for no bound. A filter the
   * user states, deliberately not a weight the ranker applies — ADR-029 keeps
   * recency off the relevance axis rather than blending them.
   */
  fromYear: number | null;
  results: AssessedRecord[];
  ranking: RankingMode;
  /** Results hidden behind the "limited verification" disclosure (ADR-029). */
  hiddenCount: number;
  /**
   * Why ranking fell back, in the user's terms. Null when it did not.
   * A silent fallback tells the user their results are unranked without telling
   * them what to fix, which is the difference between a limitation and a bug.
   */
  rankingNote: string | null;
  /** Per-source record of what was transmitted, shown on request. */
  sentQueries: SourceQuery[];
  error: string | null;

  setPassage: (passage: string) => void;
  setDraft: (draft: string) => void;
  setFromYear: (fromYear: number | null) => void;
  setPhase: (phase: LiteraturePhase) => void;
  setError: (error: string | null) => void;
  setResults: (
    results: AssessedRecord[],
    ranking: RankingMode,
    hiddenCount: number,
    rankingNote: string | null,
    sentQueries: SourceQuery[],
  ) => void;
  reset: () => void;
}

const EMPTY = {
  phase: 'idle' as LiteraturePhase,
  passage: '',
  draft: '',
  fromYear: null as number | null,
  results: [] as AssessedRecord[],
  ranking: 'source-order' as RankingMode,
  hiddenCount: 0,
  rankingNote: null as string | null,
  sentQueries: [] as SourceQuery[],
  error: null as string | null,
};

export const useLiteratureStore = create<LiteratureState>()((set) => ({
  ...EMPTY,
  setPassage: (passage) => {
    set({ passage });
  },
  setDraft: (draft) => {
    // Editing the query invalidates nothing else: results from a previous
    // search stay visible until a new one replaces them, so the pane never
    // blanks while the user is rewording.
    set({ draft });
  },
  setFromYear: (fromYear) => {
    set({ fromYear });
  },
  setPhase: (phase) => {
    set({ phase });
  },
  /**
   * Sets or clears the error. Clearing one deliberately does NOT touch `phase`.
   *
   * It used to: `setError(null)` moved the phase to `ready`, which meant the
   * ordinary opening sequence — `setPhase('drafting'); setError(null);` — set
   * the busy state and erased it on the very next line. The spinner never
   * appeared and the button never greyed out, so a working search was
   * indistinguishable from a dead button. Two pieces of state, two setters.
   */
  setError: (error) => {
    set(error === null ? { error: null } : { error, phase: 'error' });
  },
  setResults: (results, ranking, hiddenCount, rankingNote, sentQueries) => {
    set({ results, ranking, hiddenCount, rankingNote, sentQueries, phase: 'done', error: null });
  },
  reset: () => {
    set(EMPTY);
  },
}));
