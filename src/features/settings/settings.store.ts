/**
 * Persisted application settings (ARCHITECTURE.md §6, §8; ADR-005/006).
 * Flat AppSettings + two actions; persisted through the StorageService
 * envelope (validation + versioning live there, not in zustand).
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { STORAGE_KEYS, createPersistStorage } from '../../services/storage';
import type { AppSettings } from '../../types/domain';

/**
 * Defaults (ARCH §6): Ollama's own defaults for sampling; `num_ctx` 2048
 * matches the daemon default so low-RAM machines aren't surprised; direct
 * loopback URL (the Mac proxy is opt-in via settings, ADR-008).
 */
export const DEFAULT_SETTINGS: AppSettings = {
  ollamaUrl: 'http://127.0.0.1:11434',
  defaultModel: null,
  streaming: true,
  theme: 'system',
  autoCopy: false,
  autoInsert: false,
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  seed: null,
  // 2048 is too small for real work: a whole-document context alone can exceed
  // it, and Ollama trims an over-long prompt from the front, which silently
  // drops retrieved excerpts before the model ever sees them.
  contextLength: 4096,
  responseReservePct: 25,
  kbEnabled: false,
  kbUrl: 'https://localhost:11436',
  // Ollama reports installed models with their tag, so an untagged name never
  // matches the picker's list.
  defaultEmbeddingModel: 'nomic-embed-text:latest',
  // Null: use the general model (ADR-034). Most vision models chat perfectly
  // well, so the common case needs no second choice at all.
  visionModel: null,
  // Everything literature-related is off. ADR-028: no query, and no request of
  // any kind, leaves the machine until the user turns on a specific source.
  litEnabled: false,
  litSources: {
    // Off, like every other source. ADR-028 requires each to be enabled
    // individually: defaulting one on would mean flipping the master switch
    // silently contacts a third party the user never chose.
    pubmed: false,
    biorxiv: false,
    medrxiv: false,
    openalex: false,
  },
  litVerification: false,
  litDraftModel: null,
  litContactEmail: '',
  litOpenAlexKey: '',
  // Ranking is precision over this pool and cannot reach past it, so a wider
  // pool finds more — at the cost of a slower search and more embedding work
  // per source. 20 is a lighter-weight starting point than the original 50;
  // raise it per search from the Advanced panel when a topic needs a wider net.
  litResultsPerSource: 20,
  litMinVenueCitedness: 0.2,
  /*
   * 0.6, up from 0.25 (ADR-029, fifth amendment). At 0.25 the boost was a
   * tie-break; at 0.6 a well-cited result can close a 0.46 relevance gap,
   * which on real cosine distributions moves a paper from the bottom of a
   * twenty-result list to the top. That is the intent — citation count is now
   * a first-class ranking axis rather than a nudge. 0 still turns it off.
   */
  litCitationImpactWeight: 0.6,
};

/** Persistence-boundary validation; UI-level range validation is Phase 9. */
export const appSettingsSchema = z.object({
  ollamaUrl: z.string(),
  defaultModel: z.string().nullable(),
  streaming: z.boolean(),
  theme: z.enum(['light', 'dark', 'system', 'office']),
  autoCopy: z.boolean(),
  autoInsert: z.boolean(),
  temperature: z.number(),
  topP: z.number(),
  topK: z.number(),
  seed: z.number().nullable(),
  contextLength: z.number(),
  responseReservePct: z.number(),
  kbEnabled: z.boolean(),
  kbUrl: z.string(),
  defaultEmbeddingModel: z.string(),
  visionModel: z.string().nullable(),
  litEnabled: z.boolean(),
  litSources: z.object({
    pubmed: z.boolean(),
    biorxiv: z.boolean(),
    medrxiv: z.boolean(),
    openalex: z.boolean(),
  }),
  litVerification: z.boolean(),
  litDraftModel: z.string().nullable(),
  litContactEmail: z.string(),
  litOpenAlexKey: z.string(),
  litResultsPerSource: z.number(),
  litMinVenueCitedness: z.number(),
  litCitationImpactWeight: z.number(),
}) satisfies ZodType<AppSettings>;

export interface SettingsState extends AppSettings {
  /** Shallow-merges a partial update (URL, sampling, toggles, …). */
  setSettings: (patch: Partial<AppSettings>) => void;
  resetSettings: () => void;
}

const pickSettings = (state: SettingsState): AppSettings => ({
  ollamaUrl: state.ollamaUrl,
  defaultModel: state.defaultModel,
  streaming: state.streaming,
  theme: state.theme,
  autoCopy: state.autoCopy,
  autoInsert: state.autoInsert,
  temperature: state.temperature,
  topP: state.topP,
  topK: state.topK,
  seed: state.seed,
  contextLength: state.contextLength,
  responseReservePct: state.responseReservePct,
  kbEnabled: state.kbEnabled,
  kbUrl: state.kbUrl,
  defaultEmbeddingModel: state.defaultEmbeddingModel,
  visionModel: state.visionModel,
  litEnabled: state.litEnabled,
  litSources: state.litSources,
  litVerification: state.litVerification,
  litDraftModel: state.litDraftModel,
  litContactEmail: state.litContactEmail,
  litOpenAlexKey: state.litOpenAlexKey,
  litResultsPerSource: state.litResultsPerSource,
  litMinVenueCitedness: state.litMinVenueCitedness,
  litCitationImpactWeight: state.litCitationImpactWeight,
});

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      setSettings: (patch) => {
        set(patch);
      },
      resetSettings: () => {
        set(DEFAULT_SETTINGS);
      },
    }),
    {
      name: STORAGE_KEYS.settings,
      storage: createPersistStorage(STORAGE_KEYS.settings, appSettingsSchema),
      partialize: pickSettings,
    },
  ),
);
