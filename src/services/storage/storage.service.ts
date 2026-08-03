/**
 * localStorage-backed StorageService (ARCHITECTURE.md §7.3, ADR-006).
 *
 * Disk format is a versioned envelope: `{ "version": n, "data": … }`.
 * Reads are defensive end to end — unreadable storage, invalid JSON, a
 * malformed envelope, an unbridgeable version, or a schema mismatch all log a
 * warning and yield `null` (callers fall back to defaults; the app never
 * crashes on bad persisted data). Writes wrap failures (typically quota) in
 * `StorageError('quota-exceeded')`.
 */
import type { ZodType } from 'zod';
import { z } from 'zod';
import { StorageError } from '../../types/errors';
import { STORAGE_VERSIONS } from './keys';
import { adoptLegacyValue } from './legacy';
import { conversationsV1ToHistoryV2, settingsV1ToV2, settingsV2ToV3 } from './migrations';
import type { StorageKey, StorageService } from './storage.types';

const envelopeSchema = z.object({ version: z.number(), data: z.unknown() });

type Migration = (previous: unknown) => unknown;

/**
 * `MIGRATIONS[key]?.[n]` upgrades a payload FROM version n TO n + 1.
 * Deliberately empty at v1 — this is the seam future shape changes use
 * (bump STORAGE_VERSIONS, add the step here, done).
 */
const MIGRATIONS: Partial<Record<StorageKey, Record<number, Migration>>> = {
  // ADR-021: conversation threads flatten into single-shot generation records.
  'gretta/history': { 1: conversationsV1ToHistoryV2 },
  // ADR-022: corrected context-window and embedding-model defaults.
  'gretta/settings': { 1: settingsV1ToV2, 2: settingsV2ToV3 },
};

/** The subset of Web Storage the adapter needs; injectable for tests. */
export type StorageBacking = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function warn(key: StorageKey, reason: string): null {
  console.warn(`[GRETTA storage] ${key}: ${reason} — falling back to defaults.`);
  return null;
}

export function createLocalStorageService(backing?: StorageBacking): StorageService {
  const store = (): StorageBacking => backing ?? window.localStorage;

  return {
    get<T>(key: StorageKey, schema: ZodType<T>): Promise<T | null> {
      let raw: string | null;
      try {
        raw = store().getItem(key);
        // Nothing under the current name? Inherit it from the pre-rebrand
        // build once, raw, so the versioned migrations below still apply
        // normally (ADR-024).
        raw ??= adoptLegacyValue(
          key,
          (name) => store().getItem(name),
          (name, value) => {
            store().setItem(name, value);
          },
        );
      } catch {
        return Promise.resolve(warn(key, 'storage is not readable'));
      }
      if (raw === null) return Promise.resolve(null);

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return Promise.resolve(warn(key, 'stored payload is not valid JSON'));
      }

      const envelope = envelopeSchema.safeParse(json);
      if (!envelope.success) {
        return Promise.resolve(warn(key, 'stored payload has no version envelope'));
      }

      const current = STORAGE_VERSIONS[key];
      let { version } = envelope.data;
      let { data } = envelope.data;
      if (version > current) {
        return Promise.resolve(
          warn(key, `payload version ${String(version)} is newer than this build`),
        );
      }
      while (version < current) {
        const step = MIGRATIONS[key]?.[version];
        if (step === undefined) {
          return Promise.resolve(warn(key, `no migration path from version ${String(version)}`));
        }
        data = step(data);
        version += 1;
      }

      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        return Promise.resolve(warn(key, 'payload failed schema validation'));
      }
      return Promise.resolve(parsed.data);
    },

    set(key: StorageKey, value: unknown): Promise<void> {
      try {
        store().setItem(key, JSON.stringify({ version: STORAGE_VERSIONS[key], data: value }));
        return Promise.resolve();
      } catch (cause) {
        return Promise.reject(
          new StorageError(
            'quota-exceeded',
            'Saving failed — local storage is full or unavailable. Delete old conversations to free space.',
            cause,
          ),
        );
      }
    },

    remove(key: StorageKey): Promise<void> {
      try {
        store().removeItem(key);
      } catch {
        warn(key, 'storage is not writable; remove skipped');
      }
      return Promise.resolve();
    },
  };
}
