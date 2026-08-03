/**
 * Bridge between zustand's `persist` middleware and the StorageService
 * (ARCHITECTURE.md §8, ADR-006).
 *
 * Persistence is owned by ONE system: the StorageService envelope
 * (`{ version, data }`) with its central migration registry. zustand's own
 * version/migrate machinery is deliberately left inert (version pinned to 0,
 * no `migrate` option in stores) so there is exactly one place shapes evolve.
 * Validation happens on every read via the store's Zod schema; anything
 * invalid hydrates as `null`, which zustand treats as "nothing persisted" and
 * keeps the coded defaults — corrupt data can never crash the app.
 */
import type { PersistStorage, StorageValue } from 'zustand/middleware';
import type { ZodType } from 'zod';
import { createLocalStorageService } from './storage.service';
import type { StorageKey, StorageService } from './storage.types';

/** Module singleton backing all stores; tests use jsdom's real localStorage. */
export const storageService: StorageService = createLocalStorageService();

export function createPersistStorage<S>(
  key: StorageKey,
  schema: ZodType<S>,
  storage: StorageService = storageService,
): PersistStorage<S> {
  return {
    getItem: async (): Promise<StorageValue<S> | null> => {
      const data = await storage.get(key, schema);
      return data === null ? null : { state: data, version: 0 };
    },
    setItem: (_name, value): Promise<void> => storage.set(key, value.state),
    removeItem: (): Promise<void> => storage.remove(key),
  };
}
