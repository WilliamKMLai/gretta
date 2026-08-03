import { z } from 'zod';
import type { MockInstance } from 'vitest';
import { StorageError } from '../../types/errors';
import { STORAGE_KEYS, STORAGE_VERSIONS } from './keys';
import { createLocalStorageService } from './storage.service';
import type { StorageBacking } from './storage.service';

const KEY = STORAGE_KEYS.settings;
const schema = z.object({ name: z.string() });

function memoryBacking(): StorageBacking & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

let warnSpy: MockInstance<typeof console.warn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe('createLocalStorageService', () => {
  it('writes the versioned envelope and reads it back typed', async () => {
    const backing = memoryBacking();
    const storage = createLocalStorageService(backing);
    await storage.set(KEY, { name: 'llama' });
    expect(JSON.parse(backing.map.get(KEY) ?? '')).toEqual({
      version: STORAGE_VERSIONS[KEY],
      data: { name: 'llama' },
    });
    await expect(storage.get(KEY, schema)).resolves.toEqual({ name: 'llama' });
  });

  it('returns null for a missing key without warning', async () => {
    const storage = createLocalStorageService(memoryBacking());
    await expect(storage.get(KEY, schema)).resolves.toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', 'not json{'],
    ['a payload without an envelope', '{"name":"llama"}'],
    ['a newer envelope version', '{"version":99,"data":{"name":"llama"}}'],
    ['an old version with no migration path', '{"version":0,"data":{"name":"llama"}}'],
    ['a schema mismatch', '{"version":1,"data":{"name":42}}'],
  ])('falls back to null (with a warning) for %s', async (_label, raw) => {
    const backing = memoryBacking();
    backing.map.set(KEY, raw);
    const storage = createLocalStorageService(backing);
    await expect(storage.get(KEY, schema)).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('maps write failures to StorageError("quota-exceeded")', async () => {
    const backing = memoryBacking();
    backing.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const storage = createLocalStorageService(backing);
    const failure = await storage.set(KEY, { name: 'x' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).kind).toBe('quota-exceeded');
  });

  it('remove succeeds silently even when the backing store throws', async () => {
    const backing = memoryBacking();
    backing.removeItem = () => {
      throw new Error('nope');
    };
    const storage = createLocalStorageService(backing);
    await expect(storage.remove(KEY)).resolves.toBeUndefined();
  });
});
