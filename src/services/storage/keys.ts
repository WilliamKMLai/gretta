/**
 * Central registry of persistence slots (ARCHITECTURE.md §7.3, ADR-006).
 * One key and one payload version per persisted store; bump a version here
 * (and add the migration in storage.service.ts) when its shape changes.
 */
import type { StorageKey } from './storage.types';

export const STORAGE_KEYS = {
  settings: 'gretta/settings',
  /**
   * Generation history (ADR-021). The v1 → v2 migration flattens threads into
   * records in place. Pre-rebrand installs have this data under the old
   * `wordllama/conversations` key, which `legacy.ts` adopts once (ADR-024).
   */
  history: 'gretta/history',
  prompts: 'gretta/prompts',
  /** Derived prompt-size measurements per model (ADR-025). */
  calibration: 'gretta/calibration',
  /** Cached literature search results, keyed by query+sources (ADR-028). */
  literatureCache: 'gretta/literature-cache',
} as const satisfies Record<string, StorageKey>;

/** Current envelope version per key — `{ version, data }` on disk. */
export const STORAGE_VERSIONS: Record<StorageKey, number> = {
  // v2: raise the too-small default context window and tag the default
  // embedding model (ADR-022) — only where the user never changed them.
  // v3: kbDefaultEmbeddingModel → defaultEmbeddingModel, since ADR-030 makes it
  // serve literature re-ranking as well as the knowledge base.
  // v4: add litCitationImpactWeight (ADR-029's citation-impact-ranking amendment).
  // v5: rescale litCitationImpactWeight — it now weights a log-scaled raw
  // citation count rather than a frequently-null percentile (ADR-029, fifth
  // amendment), so the old default no longer means the same thing.
  // v6: add visionModel, defaulting to null = "use the general model" (ADR-034).
  'gretta/settings': 6,
  // v2: conversation threads → flat generation records (ADR-021).
  'gretta/history': 2,
  'gretta/prompts': 1,
  'gretta/calibration': 1,
  'gretta/literature-cache': 1,
};
