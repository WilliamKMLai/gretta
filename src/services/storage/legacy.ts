/**
 * One-time adoption of data written by the pre-rebrand build (ADR-024).
 *
 * GRETTA was renamed from an earlier tool that used `wordllama/*` storage keys.
 * A rename alone would silently orphan a user's settings, prompt library, and
 * generation history — the data is still in localStorage, just under names
 * nothing reads any more.
 *
 * Adoption copies the RAW envelope, not parsed data, so the normal versioned
 * migrations still run afterwards exactly as they would have. It happens once:
 * as soon as the new key exists, the legacy key is never consulted again, and
 * the old value is left untouched so the previous build keeps working.
 *
 * This module is the whole compatibility surface. Delete it, its call in
 * `storage.service.ts`, and `LEGACY_BINDING_KEY` in the knowledge-base feature
 * for a clean break with no history.
 */
import type { StorageKey } from './storage.types';

/** New key → the key the pre-rebrand build wrote. */
const LEGACY_KEYS: Record<StorageKey, string> = {
  'gretta/settings': 'wordllama/settings',
  'gretta/history': 'wordllama/conversations',
  'gretta/prompts': 'wordllama/prompts',
  // Introduced after the rebrand; there is nothing to inherit.
  'gretta/calibration': '',
};

/**
 * If `key` has no value but its pre-rebrand equivalent does, copy the raw
 * envelope across. Returns the adopted string, or null when there was nothing
 * to adopt. Never throws: failing to inherit old data must not break startup.
 */
export function adoptLegacyValue(
  key: StorageKey,
  read: (name: string) => string | null,
  write: (name: string, value: string) => void,
): string | null {
  try {
    if (read(key) !== null) return null;
    const legacyKey = LEGACY_KEYS[key];
    if (legacyKey === '') return null;
    const legacyValue = read(legacyKey);
    if (legacyValue === null) return null;
    write(key, legacyValue);
    console.info(`[gretta] Adopted settings from the previous build (${legacyKey}).`);
    return legacyValue;
  } catch {
    return null;
  }
}
