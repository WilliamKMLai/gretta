/**
 * Central registry of persistence slots (ARCHITECTURE.md §7.3, ADR-006).
 * One key and one payload version per persisted store; bump a version here
 * (and add the migration in storage.service.ts) when its shape changes.
 */
import type { StorageKey } from './storage.types';

export const STORAGE_KEYS = {
  settings: 'gretta/settings',
  /**
   * Generation history (ADR-021). The key string is deliberately still
   * `conversations`: existing installs have data under it, and the v1 → v2
   * migration flattens threads into records in place. Renaming the string
   * would orphan that data.
   */
  history: 'gretta/history',
  prompts: 'gretta/prompts',
  /** Derived prompt-size measurements per model (ADR-025). */
  calibration: 'gretta/calibration',
} as const satisfies Record<string, StorageKey>;

/** Current envelope version per key — `{ version, data }` on disk. */
export const STORAGE_VERSIONS: Record<StorageKey, number> = {
  // v2: raise the too-small default context window and tag the default
  // embedding model (ADR-022) — only where the user never changed them.
  // v3: kbDefaultEmbeddingModel → defaultEmbeddingModel, since ADR-030 makes it
  // serve literature re-ranking as well as the knowledge base.
  'gretta/settings': 3,
  // v2: conversation threads → flat generation records (ADR-021).
  'gretta/history': 2,
  'gretta/prompts': 1,
  'gretta/calibration': 1,
};
