/**
 * Generation history (ARCHITECTURE.md §6, §8; ADR-005/006, ADR-021).
 *
 * A flat, reverse-chronological list of self-contained generation records —
 * NOT chat threads. Generation is single-shot (§11.1: prior turns are never
 * resent), so a thread would advertise a continuity the engine does not have.
 * Recording each run on its own also keeps knowledge-base provenance
 * unambiguous: one record, one set of sources (ADR-020).
 *
 * This store records results; producing them (streaming, stats, retrieval) is
 * the ai feature's job.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { STORAGE_KEYS, createPersistStorage } from '../../services/storage';
import type { AppliedAction, GenerationRecord } from '../../types/domain';
import { newId } from '../../utils/id';
import { persistedHistorySchema } from './history.schema';
import type { PersistedHistory } from './history.schema';

/** Newest first; older entries fall off so storage cannot grow without bound. */
export const HISTORY_LIMIT = 200;

/** Everything about a run except the identity the store assigns. */
export type NewGenerationRecord = Omit<GenerationRecord, 'id' | 'createdAt'>;

export interface HistoryState extends PersistedHistory {
  /** The record open in the chat view, or null for a fresh prompt. */
  activeRecordId: string | null;

  /** Records a finished run (any outcome) and returns its id. */
  addRecord: (record: NewGenerationRecord) => string;
  setActiveRecord: (id: string | null) => void;
  deleteRecord: (id: string) => void;
  clearRecords: () => void;
  /** Notes that the user put a result into the document. */
  markApplied: (id: string, kind: AppliedAction['kind']) => void;
}

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set) => ({
      records: [],
      activeRecordId: null,

      addRecord: (record) => {
        const created: GenerationRecord = {
          ...record,
          id: newId(),
          createdAt: new Date().toISOString(),
        };
        set((state) => ({
          records: [created, ...state.records].slice(0, HISTORY_LIMIT),
          activeRecordId: created.id,
        }));
        return created.id;
      },

      setActiveRecord: (id) => {
        set({ activeRecordId: id });
      },

      deleteRecord: (id) => {
        set((state) => ({
          records: state.records.filter((record) => record.id !== id),
          activeRecordId: state.activeRecordId === id ? null : state.activeRecordId,
        }));
      },

      clearRecords: () => {
        set({ records: [], activeRecordId: null });
      },

      markApplied: (id, kind) => {
        const at = new Date().toISOString();
        set((state) => ({
          records: state.records.map((record) =>
            record.id === id ? { ...record, applied: { kind, at } } : record,
          ),
        }));
      },
    }),
    {
      name: STORAGE_KEYS.history,
      storage: createPersistStorage(STORAGE_KEYS.history, persistedHistorySchema),
      partialize: (state): PersistedHistory => ({ records: state.records }),
    },
  ),
);

/** Compact one-line summary of a record for the list. */
export function describeRecord(record: GenerationRecord): string {
  const collapsed = record.prompt.replace(/\s+/gu, ' ').trim();
  if (collapsed !== '') return collapsed;
  return record.templateName ?? 'Untitled generation';
}
