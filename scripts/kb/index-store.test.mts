import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionConfig, QueryDefaults } from '../../src/types/knowledgebase';
import { CollectionIndexer, KB_MAX_CHUNKS, capacityPct } from './index-store.mts';
import type { ChunkRow, SqliteStore } from './store.sqlite.mts';

/**
 * `CollectionIndexer.query()`'s ranking matrix is cached per instance and
 * must be invalidated on every write path (ADR-020 amendment) — otherwise a
 * query can serve stale chunks after an edit, a delete, or a config change.
 * These tests drive the invalidation through the public API with a fake
 * `SqliteStore` (a plain object matching its shape, `import type`-only so no
 * better-sqlite3 native binding loads) and, where a real file needs parsing,
 * a real temp folder plus the `DeterministicEmbedder` seam
 * (`GRETTA_KB_FAKE_EMBED=1`) so nothing here touches the network.
 */

const DEFAULTS: QueryDefaults = { topK: 8, minScore: 0 };

function config(overrides: Partial<CollectionConfig> = {}): CollectionConfig {
  return { id: 'a', name: 'A', folders: [], embeddingModel: 'm1', ...overrides };
}

function createFakeStore(options: { indexedSources?: string[]; fileHash?: string | null } = {}) {
  return {
    counts: vi.fn(() => ({ fileCount: 0, chunkCount: 0 })),
    getCollection: vi.fn(() => null),
    upsertCollection: vi.fn(),
    clearCollection: vi.fn(),
    indexedSources: vi.fn(() => options.indexedSources ?? []),
    removeFile: vi.fn(),
    fileHash: vi.fn(() => options.fileHash ?? null),
    replaceFile: vi.fn(),
    markIndexed: vi.fn(),
    chunkVectors: vi.fn(() => ({ matrix: new Float32Array(0), rowIds: [] as number[], dims: 0 })),
    chunksByRowIds: vi.fn((rowIds: number[]): ChunkRow[] => {
      void rowIds;
      return [];
    }),
  };
}

function asStore(fake: ReturnType<typeof createFakeStore>): SqliteStore {
  return fake as unknown as SqliteStore;
}

describe('CollectionIndexer query-matrix caching', () => {
  let dir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('returns [] for blank query text without touching the store', async () => {
    const store = createFakeStore();
    const indexer = new CollectionIndexer(config(), asStore(store), DEFAULTS, 'http://x');
    expect(await indexer.query('   ')).toEqual([]);
    expect(store.chunkVectors).not.toHaveBeenCalled();
  });

  it('caches the ranking matrix across repeated queries', async () => {
    const store = createFakeStore();
    const indexer = new CollectionIndexer(config(), asStore(store), DEFAULTS, 'http://x');
    await indexer.query('hello');
    await indexer.query('hello again');
    expect(store.chunkVectors).toHaveBeenCalledTimes(1);
  });

  it('reindex() invalidates the cache even when nothing changed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kb-index-'));
    const store = createFakeStore();
    const indexer = new CollectionIndexer(
      config({ folders: [dir] }),
      asStore(store),
      DEFAULTS,
      'http://x',
    );
    await indexer.query('hello');
    await indexer.reindex();
    await indexer.query('hello');
    expect(store.chunkVectors).toHaveBeenCalledTimes(2);
  });

  it('a full reindex clears the collection and invalidates the cache', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kb-index-'));
    const store = createFakeStore();
    const indexer = new CollectionIndexer(
      config({ folders: [dir] }),
      asStore(store),
      DEFAULTS,
      'http://x',
    );
    await indexer.query('hello');
    await indexer.reindex(true);
    expect(store.clearCollection).toHaveBeenCalledWith('a');
    await indexer.query('hello');
    expect(store.chunkVectors).toHaveBeenCalledTimes(2);
  });

  it('a disabled collection (no folders) clears and invalidates on reindex', async () => {
    const store = createFakeStore();
    const indexer = new CollectionIndexer(
      config({ folders: [] }),
      asStore(store),
      DEFAULTS,
      'http://x',
    );
    await indexer.query('hello');
    await indexer.reindex();
    expect(store.clearCollection).toHaveBeenCalledWith('a');
    await indexer.query('hello');
    expect(store.chunkVectors).toHaveBeenCalledTimes(2);
  });

  it('setConfig invalidates the cache', async () => {
    const store = createFakeStore();
    const indexer = new CollectionIndexer(
      config({ folders: [] }),
      asStore(store),
      DEFAULTS,
      'http://x',
    );
    await indexer.query('hello');
    await indexer.setConfig(config({ folders: [], name: 'Renamed' }));
    await indexer.query('hello');
    expect(store.chunkVectors).toHaveBeenCalledTimes(2);
  });

  it('a vanished source invalidates the cache via removeFile', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kb-index-'));
    const store = createFakeStore({ indexedSources: ['ghost.md'] });
    const indexer = new CollectionIndexer(
      config({ folders: [dir] }),
      asStore(store),
      DEFAULTS,
      'http://x',
    );
    await indexer.query('hello');
    await indexer.reindex();
    expect(store.removeFile).toHaveBeenCalledWith('a', 'ghost.md');
    await indexer.query('hello');
    expect(store.chunkVectors).toHaveBeenCalledTimes(2);
  });

  it('a changed file invalidates the cache via replaceFile', async () => {
    vi.stubEnv('GRETTA_KB_FAKE_EMBED', '1');
    dir = mkdtempSync(join(tmpdir(), 'kb-index-'));
    writeFileSync(join(dir, 'doc.txt'), 'Hello world.\n\nA second paragraph.');
    const store = createFakeStore({ fileHash: null });
    const indexer = new CollectionIndexer(
      config({ folders: [dir] }),
      asStore(store),
      DEFAULTS,
      'http://x',
    );
    await indexer.query('hello');
    await indexer.reindex();
    expect(store.replaceFile).toHaveBeenCalled();
    await indexer.query('hello');
    expect(store.chunkVectors).toHaveBeenCalledTimes(2);
  });

  it('maps ranked matches back to RetrievedChunk, preserving score order', async () => {
    vi.stubEnv('GRETTA_KB_FAKE_EMBED', '1');
    const store = createFakeStore();
    store.chunkVectors.mockReturnValue({
      matrix: Float32Array.from([1, 0, 0, 1]),
      rowIds: [10, 20],
      dims: 2,
    });
    store.chunksByRowIds.mockImplementation((rowIds: number[]) =>
      rowIds.map((rowId): ChunkRow => ({
        rowId,
        collectionId: 'a',
        source: rowId === 10 ? 'east.md' : 'north.md',
        page: null,
        paragraph: rowId,
        text: rowId === 10 ? 'east text' : 'north text',
      })),
    );
    const indexer = new CollectionIndexer(config(), asStore(store), DEFAULTS, 'http://x');

    const results = await indexer.query('anything');

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.collectionId).toBe('a');
      if (result.source === 'east.md') expect(result.text).toBe('east text');
      if (result.source === 'north.md') expect(result.text).toBe('north text');
    }
    const [first, second] = results;
    if (first === undefined || second === undefined) throw new Error('expected two results');
    expect(first.score).toBeGreaterThanOrEqual(second.score);
  });
});

describe('capacityPct and overCapacity', () => {
  it.each([
    [0, 0],
    [KB_MAX_CHUNKS - 1, 100], // rounds up: 29,999 / 30,000 ≈ 99.997%
    [KB_MAX_CHUNKS, 100],
    [KB_MAX_CHUNKS + 1, 100],
  ])('capacityPct(%i) is %i%%', (chunkCount, expected) => {
    expect(capacityPct(chunkCount)).toBe(expected);
  });

  it.each([
    [0, false],
    [KB_MAX_CHUNKS - 1, false],
    [KB_MAX_CHUNKS, false],
    [KB_MAX_CHUNKS + 1, true],
  ])('status().overCapacity for %i chunks is %s', (chunkCount, expected) => {
    const store = createFakeStore();
    store.counts.mockReturnValue({ fileCount: 1, chunkCount });
    const indexer = new CollectionIndexer(config(), asStore(store), DEFAULTS, 'http://x');
    expect(indexer.status().overCapacity).toBe(expected);
  });

  it('the rounded percentage cannot distinguish just-under from just-over the ceiling — overCapacity can', () => {
    expect(capacityPct(KB_MAX_CHUNKS - 1)).toBe(capacityPct(KB_MAX_CHUNKS + 1));

    const under = createFakeStore();
    under.counts.mockReturnValue({ fileCount: 1, chunkCount: KB_MAX_CHUNKS - 1 });
    expect(
      new CollectionIndexer(config(), asStore(under), DEFAULTS, 'http://x').status().overCapacity,
    ).toBe(false);

    const over = createFakeStore();
    over.counts.mockReturnValue({ fileCount: 1, chunkCount: KB_MAX_CHUNKS + 1 });
    expect(
      new CollectionIndexer(config(), asStore(over), DEFAULTS, 'http://x').status().overCapacity,
    ).toBe(true);
  });

  it('indexing is never truncated at the ceiling — status just reports it honestly', () => {
    const store = createFakeStore();
    store.counts.mockReturnValue({ fileCount: 10, chunkCount: KB_MAX_CHUNKS * 3 });
    const indexer = new CollectionIndexer(config(), asStore(store), DEFAULTS, 'http://x');
    const status = indexer.status();
    expect(status.chunkCount).toBe(KB_MAX_CHUNKS * 3);
    expect(status.overCapacity).toBe(true);
  });
});
