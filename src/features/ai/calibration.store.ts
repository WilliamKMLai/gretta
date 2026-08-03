/**
 * Per-model prompt-size calibration (ADR-025).
 *
 * Ollama reports `prompt_eval_count` on every completed generation — the real
 * token count for the prompt it just processed. Comparing that against what was
 * estimated turns a fixed heuristic into one that learns each model's actual
 * tokenisation, and persisting it means the accuracy survives a restart rather
 * than being re-learned every session.
 *
 * This is derived measurement, not user configuration, which is why it lives
 * in its own store rather than in settings.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { STORAGE_KEYS, createPersistStorage } from '../../services/storage';
import { DEFAULT_CHARS_PER_TOKEN, observeRatio } from '../../utils/tokens';
import { persistedCalibrationSchema } from './calibration.schema';
import type { PersistedCalibration } from './calibration.schema';

export interface CalibrationState extends PersistedCalibration {
  /** Calibrated ratio for a model, or the conservative default. */
  ratioFor: (model: string) => number;
  /** Folds one completed generation into the model's ratio. */
  observe: (model: string, promptChars: number, promptEvalCount: number) => void;
}

export const useCalibrationStore = create<CalibrationState>()(
  persist(
    (set, get) => ({
      ratios: {},

      ratioFor: (model) => get().ratios[model] ?? DEFAULT_CHARS_PER_TOKEN,

      observe: (model, promptChars, promptEvalCount) => {
        const previous = get().ratios[model] ?? DEFAULT_CHARS_PER_TOKEN;
        const next = observeRatio(previous, promptChars, promptEvalCount);
        if (next === previous) return; // sample rejected; nothing to store
        set((state) => ({ ratios: { ...state.ratios, [model]: next } }));
      },
    }),
    {
      name: STORAGE_KEYS.calibration,
      storage: createPersistStorage(STORAGE_KEYS.calibration, persistedCalibrationSchema),
      partialize: (state): PersistedCalibration => ({ ratios: state.ratios }),
    },
  ),
);
