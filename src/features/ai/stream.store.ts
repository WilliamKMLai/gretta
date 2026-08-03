/**
 * Streaming state machine (ARCHITECTURE.md §9; ADR-005/011). Ephemeral —
 * never persisted.
 *
 *   idle ─start()→ connecting ─appendToken→ streaming ─complete→ completed
 *     ▲                │                        │
 *     │                │ fail                   ├─ cancel() → cancelled
 *     └── reset() ─────┴───────── fail ◄────────┘   (both keep partial text)
 *
 * `cancelled` is a normal terminal state, not an error; `error` keeps the
 * partial text plus the typed failure. Invalid transitions are ignored (a
 * late token after cancel must not corrupt state). rAF batching of token
 * appends is the Phase 7 hook's job — the store itself is synchronous.
 */
import { create } from 'zustand';
import type { AppError } from '../../types/errors';
import type { GenerationStats } from '../../types/domain';
import type { GenerationRecord } from '../../types/domain';
import type { RetrievedChunk } from '../../types/knowledgebase';
import type { BudgetResult } from './context/budget';

export type StreamStatus =
  'idle' | 'connecting' | 'streaming' | 'completed' | 'cancelled' | 'error';

/** What the active request is doing, for the UI header and history append. */
export interface StreamRequestMeta {
  model: string;
  promptId: string | null;
  /** Chunks retrieved for this run; rendered as citations (ADR-020). */
  sources?: RetrievedChunk[];
  /** Budget outcome for this run (ADR-025). */
  budget?: BudgetResult;
}

export interface StreamState {
  status: StreamStatus;
  /** Response text so far (partial in cancelled/error states). */
  text: string;
  stats: GenerationStats | null;
  error: AppError | null;
  request: StreamRequestMeta | null;
  /** Provenance for the current response; empty when RAG contributed nothing. */
  sources: RetrievedChunk[];
  /** What had to be given up to fit the context window (ADR-025). */
  budget: BudgetResult | null;

  /** idle/terminal → connecting; clears text, stats, and error. */
  start: (request: StreamRequestMeta) => void;
  /** connecting → streaming on first token; appends while streaming. */
  appendToken: (content: string) => void;
  /** connecting|streaming → completed. */
  complete: (stats: GenerationStats) => void;
  /** connecting|streaming → cancelled; partial text is kept. */
  cancel: () => void;
  /** connecting|streaming → error; partial text is kept. */
  fail: (error: AppError) => void;
  /** any → idle. */
  reset: () => void;
  /**
   * Shows a finished run from history without re-running it (ADR-021). The
   * response pane reads only from this store, so opening a past record has to
   * load it here — otherwise the pane keeps showing the last live generation.
   */
  restore: (record: GenerationRecord) => void;
}

const TERMINAL: readonly StreamStatus[] = ['idle', 'completed', 'cancelled', 'error'];
const ACTIVE: readonly StreamStatus[] = ['connecting', 'streaming'];

export const useStreamStore = create<StreamState>()((set, get) => ({
  status: 'idle',
  text: '',
  stats: null,
  error: null,
  request: null,
  sources: [],
  budget: null,

  start: (request) => {
    if (!TERMINAL.includes(get().status)) return;
    set({
      status: 'connecting',
      text: '',
      stats: null,
      error: null,
      request,
      sources: request.sources ?? [],
      budget: request.budget ?? null,
    });
  },

  appendToken: (content) => {
    const { status, text } = get();
    if (!ACTIVE.includes(status)) return;
    set({ status: 'streaming', text: text + content });
  },

  complete: (stats) => {
    if (!ACTIVE.includes(get().status)) return;
    set({ status: 'completed', stats });
  },

  cancel: () => {
    if (!ACTIVE.includes(get().status)) return;
    set({ status: 'cancelled' });
  },

  fail: (error) => {
    if (!ACTIVE.includes(get().status)) return;
    set({ status: 'error', error });
  },

  reset: () => {
    set({
      status: 'idle',
      text: '',
      stats: null,
      error: null,
      request: null,
      sources: [],
      budget: null,
    });
  },

  restore: (record) => {
    if (!TERMINAL.includes(get().status)) return; // never interrupt a live run
    set({
      status: record.outcome === 'completed' ? 'completed' : 'cancelled',
      text: record.response,
      stats: record.stats ?? null,
      error: null,
      request: { model: record.model, promptId: record.templateId ?? null },
      sources: record.sources ?? [],
      budget: null, // a restored record is not a live request
    });
  },
}));
