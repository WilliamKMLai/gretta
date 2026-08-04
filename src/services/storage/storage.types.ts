/**
 * Persistence boundary contract (ARCHITECTURE.md §7.3, ADR-006).
 *
 * `services/storage` is the ONLY place `localStorage` (and, later, IndexedDB)
 * may be touched — rule zero, enforced by lint. The interface is async from
 * day one so swapping the backing store never ripples upward. Every read is
 * validated against a caller-supplied Zod schema; corrupt or unmigratable data
 * yields `null`, never a crash. Phase 5 supplies the implementation with
 * versioned `{ version, data }` envelopes and migrations.
 */
import type { ZodType } from 'zod';

/** Closed set of persistence slots; one per persisted store. */
export type StorageKey =
  | 'gretta/settings'
  | 'gretta/history'
  | 'gretta/prompts'
  | 'gretta/calibration'
  | 'gretta/literature-cache';

/** Typed, validated, async key-value persistence. */
export interface StorageService {
  /**
   * Reads and validates a value. Returns `null` when the key is absent or the
   * stored payload fails schema validation (after attempting migrations).
   */
  get<T>(key: StorageKey, schema: ZodType<T>): Promise<T | null>;

  /** Serializes and writes a value, wrapping it in the versioned envelope. */
  set(key: StorageKey, value: unknown): Promise<void>;

  /** Deletes a key; succeeds silently when the key is absent. */
  remove(key: StorageKey): Promise<void>;
}
