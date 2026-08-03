/**
 * Knowledge-base feature state (ADR-005 colocated store; ADR-020).
 *
 * Two very different things live here on purpose:
 *  - the ACTIVE DOCUMENT'S BINDING (which collections this .docx uses), which
 *    is persisted inside the document itself via Office settings, not in app
 *    storage — so it travels with the file;
 *  - a mirror of the companion's per-collection index status, fed by the
 *    NDJSON progress stream, which is ephemeral cache, not persisted.
 *
 * The collection list itself is server cache owned by TanStack Query
 * (`useKbCollections`); this store holds only what Query cannot.
 */
import { create } from 'zustand';
import type { CollectionStatus, IndexProgressEvent } from '../../types/knowledgebase';

/** Office document-settings key holding the bound collection ids. */
export const KB_BINDING_KEY = 'gretta:kbCollections';

/**
 * The key the pre-rebrand build wrote into documents (ADR-024). Bindings live
 * inside the .docx, so documents a user already bound would silently stop
 * retrieving after the rename. Read-only fallback: GRETTA adopts it and writes
 * the current key from then on. Delete for a clean break.
 */
export const LEGACY_KB_BINDING_KEY = 'wordllama:kbCollections';

export interface KnowledgeBaseState {
  /** Collections bound to the open document (from Office document settings). */
  boundCollectionIds: string[];
  /** True once the binding has been read from the document. */
  bindingLoaded: boolean;
  /** Live progress per collection id, overlaid on the fetched status. */
  progress: Record<string, IndexProgressEvent | undefined>;

  setBinding: (ids: string[]) => void;
  markBindingLoaded: () => void;
  applyProgress: (collectionId: string, event: IndexProgressEvent) => void;
  clearProgress: (collectionId: string) => void;
}

export const useKnowledgeBaseStore = create<KnowledgeBaseState>()((set) => ({
  boundCollectionIds: [],
  bindingLoaded: false,
  progress: {},

  setBinding: (ids) => {
    set({ boundCollectionIds: [...new Set(ids)] });
  },
  markBindingLoaded: () => {
    set({ bindingLoaded: true });
  },
  applyProgress: (collectionId, event) => {
    set((state) => ({ progress: { ...state.progress, [collectionId]: event } }));
  },
  clearProgress: (collectionId) => {
    set((state) => ({
      progress: Object.fromEntries(
        Object.entries(state.progress).filter(([id]) => id !== collectionId),
      ),
    }));
  },
}));

/** Human-readable one-liner for a collection's current indexing state. */
export function describePhase(status: CollectionStatus): string {
  switch (status.phase) {
    case 'disabled':
      return 'No folders configured';
    case 'idle':
      return 'Waiting to index';
    case 'scanning':
      return 'Scanning folders…';
    case 'indexing':
      return 'Indexing…';
    case 'ollama-unreachable':
      return 'Paused — Ollama unreachable';
    case 'error':
      return status.message ?? 'Indexing error';
    case 'ready':
      return status.chunkCount === 0 ? 'Indexed, but nothing searchable yet' : 'Ready to search';
  }
}
