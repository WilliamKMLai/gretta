import { describe, expect, it, vi } from 'vitest';
import type { QueryDefaults, RetrievedChunk } from '../../src/types/knowledgebase';
import { CollectionRegistry } from './registry.mts';
import type { CollectionIndexer } from './index-store.mts';
import type { ChunkRow, CollectionRow, SqliteStore } from './store.sqlite.mts';

/**
 * `CollectionRegistry.query()` embeds the query text once per DISTINCT
 * EMBEDDING MODEL rather than once per collection (ADR-020 amendment).
 * Sharing a vector is only sound within a model — ADR-020's "vectors from
 * different models are not comparable" invariant is the grouping key — so
 * these tests pin both halves: shared within a group, never across groups.
 *
 * Watching is disabled throughout (the constructor's 4th argument), so no
 * `fs.watch` handle is ever installed and nothing needs tearing down.
 */

const DEFAULTS: QueryDefaults = { topK: 8, minScore: 0 };

function collectionRow(id: string, embeddingModel: string): CollectionRow {
  return { id, name: id, folders: [], embeddingModel, lastIndexedAt: null };
}

/**
 * A store whose collections each report one chunk, so every indexer is
 * non-empty (`hasChunks`) and therefore eligible for grouping. `chunkVectors`
 * is keyed per collection so each ranks its own row.
 */
function createFakeStore(collections: CollectionRow[]) {
  const rowIdFor = (id: string): number => collections.findIndex((row) => row.id === id) + 10;
  return {
    listCollections: vi.fn(() => collections),
    counts: vi.fn(() => ({ fileCount: 1, chunkCount: 1 })),
    getCollection: vi.fn(() => null),
    upsertCollection: vi.fn(),
    clearCollection: vi.fn(),
    deleteCollection: vi.fn(),
    indexedSources: vi.fn(() => []),
    removeFile: vi.fn(),
    fileHash: vi.fn(() => null),
    replaceFile: vi.fn(),
    markIndexed: vi.fn(),
    chunkVectors: vi.fn((ids: string[]) => ({
      matrix: Float32Array.from([1, 0]),
      rowIds: [rowIdFor(ids[0] ?? '')],
      dims: 2,
    })),
    chunksByRowIds: vi.fn((rowIds: number[]): ChunkRow[] =>
      rowIds.map((rowId) => ({
        rowId,
        collectionId: collections[rowId - 10]?.id ?? 'unknown',
        source: `${collections[rowId - 10]?.id ?? 'unknown'}.md`,
        page: null,
        paragraph: 1,
        text: `text from ${collections[rowId - 10]?.id ?? 'unknown'}`,
      })),
    ),
  };
}

function asStore(fake: ReturnType<typeof createFakeStore>): SqliteStore {
  return fake as unknown as SqliteStore;
}

/** Replaces each indexer's embed + rank with spies, so calls are countable. */
function instrument(
  registry: CollectionRegistry,
  ids: string[],
): { embed: Map<string, ReturnType<typeof vi.fn>>; indexers: Map<string, CollectionIndexer> } {
  const embed = new Map<string, ReturnType<typeof vi.fn>>();
  const indexers = new Map<string, CollectionIndexer>();
  for (const id of ids) {
    const indexer = registry.get(id);
    if (indexer === null) throw new Error(`no indexer for ${id}`);
    indexers.set(id, indexer);
    const spy = vi.fn(() => Promise.resolve([1, 0]));
    vi.spyOn(indexer, 'embedQuery').mockImplementation(spy);
    embed.set(id, spy);
  }
  return { embed, indexers };
}

/** Total embed calls across every collection — the number this feature reduces. */
function totalEmbeds(embed: Map<string, ReturnType<typeof vi.fn>>): number {
  return [...embed.values()].reduce((sum, spy) => sum + spy.mock.calls.length, 0);
}

describe('CollectionRegistry.query — embedding dedupe', () => {
  it('embeds ONCE for several collections sharing one model, and still ranks each', async () => {
    const rows = [
      collectionRow('a', 'nomic-embed-text'),
      collectionRow('b', 'nomic-embed-text'),
      collectionRow('c', 'nomic-embed-text'),
    ];
    const registry = new CollectionRegistry(
      asStore(createFakeStore(rows)),
      DEFAULTS,
      'http://x',
      false,
    );
    const { embed, indexers } = instrument(registry, ['a', 'b', 'c']);
    const queries = ['a', 'b', 'c'].map((id) => {
      const indexer = indexers.get(id);
      if (indexer === undefined) throw new Error('missing indexer');
      return vi.spyOn(indexer, 'query');
    });

    const results = await registry.query(['a', 'b', 'c'], 'hello');

    // One embed total, not three — the whole point of the change.
    expect(totalEmbeds(embed)).toBe(1);
    // ...yet every collection still ranked its own chunks.
    for (const spy of queries) expect(spy).toHaveBeenCalledTimes(1);
    expect(results.map((chunk) => chunk.collectionId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('passes the SAME vector to every collection in a model group', async () => {
    const rows = [collectionRow('a', 'nomic-embed-text'), collectionRow('b', 'nomic-embed-text')];
    const registry = new CollectionRegistry(
      asStore(createFakeStore(rows)),
      DEFAULTS,
      'http://x',
      false,
    );
    const { indexers } = instrument(registry, ['a', 'b']);
    const queries = ['a', 'b'].map((id) => {
      const indexer = indexers.get(id);
      if (indexer === undefined) throw new Error('missing indexer');
      return vi.spyOn(indexer, 'query');
    });

    await registry.query(['a', 'b'], 'hello');

    const vectors = queries.map((spy) => spy.mock.calls[0]?.[2]);
    expect(vectors[0]).toEqual([1, 0]);
    expect(vectors[1]).toEqual(vectors[0]);
  });

  it('embeds once PER MODEL when the bound collections mix models', async () => {
    const rows = [
      collectionRow('a', 'nomic-embed-text'),
      collectionRow('b', 'nomic-embed-text'),
      collectionRow('c', 'mxbai-embed-large'),
    ];
    const registry = new CollectionRegistry(
      asStore(createFakeStore(rows)),
      DEFAULTS,
      'http://x',
      false,
    );
    const { embed } = instrument(registry, ['a', 'b', 'c']);

    await registry.query(['a', 'b', 'c'], 'hello');

    // Two distinct models → exactly two embeds, never one shared across models:
    // vectors from different models are not comparable (ADR-020).
    expect(totalEmbeds(embed)).toBe(2);
    expect(embed.get('a')?.mock.calls.length).toBe(1); // group leader
    expect(embed.get('b')?.mock.calls.length).toBe(0); // shares a's vector
    expect(embed.get('c')?.mock.calls.length).toBe(1); // own model, own embed
  });

  it('does not embed at all when every requested collection is empty', async () => {
    const rows = [collectionRow('a', 'nomic-embed-text'), collectionRow('b', 'nomic-embed-text')];
    const store = createFakeStore(rows);
    // An empty collection returned before embedding even before the dedupe;
    // letting one lead a group would load a cold model for nothing.
    store.chunkVectors.mockReturnValue({ matrix: new Float32Array(0), rowIds: [], dims: 0 });
    const registry = new CollectionRegistry(asStore(store), DEFAULTS, 'http://x', false);
    const { embed } = instrument(registry, ['a', 'b']);

    await expect(registry.query(['a', 'b'], 'hello')).resolves.toEqual([]);
    expect(totalEmbeds(embed)).toBe(0);
  });

  it('skips an unknown collection id silently, as it always has', async () => {
    const rows = [collectionRow('a', 'nomic-embed-text')];
    const registry = new CollectionRegistry(
      asStore(createFakeStore(rows)),
      DEFAULTS,
      'http://x',
      false,
    );
    const { embed } = instrument(registry, ['a']);

    const results = await registry.query(['a', 'ghost'], 'hello');

    expect(totalEmbeds(embed)).toBe(1);
    expect(results.map((chunk) => chunk.collectionId)).toEqual(['a']);
  });

  it('returns [] and embeds nothing for blank query text', async () => {
    const rows = [collectionRow('a', 'nomic-embed-text')];
    const registry = new CollectionRegistry(
      asStore(createFakeStore(rows)),
      DEFAULTS,
      'http://x',
      false,
    );
    const { embed } = instrument(registry, ['a']);

    await expect(registry.query(['a'], '   ')).resolves.toEqual([]);
    expect(totalEmbeds(embed)).toBe(0);
  });

  it('merges across model groups, sorted by score and capped at the limit', async () => {
    const rows = [
      collectionRow('a', 'nomic-embed-text'),
      collectionRow('b', 'mxbai-embed-large'),
      collectionRow('c', 'nomic-embed-text'),
    ];
    const registry = new CollectionRegistry(
      asStore(createFakeStore(rows)),
      DEFAULTS,
      'http://x',
      false,
    );
    const { indexers } = instrument(registry, ['a', 'b', 'c']);
    const scores: Record<string, number> = { a: 0.4, b: 0.9, c: 0.7 };
    for (const [id, indexer] of indexers) {
      vi.spyOn(indexer, 'query').mockResolvedValue([
        {
          collectionId: id,
          source: `${id}.md`,
          locator: { page: null, paragraph: 1 },
          text: `text from ${id}`,
          score: scores[id] ?? 0,
        },
      ] satisfies RetrievedChunk[]);
    }

    const results = await registry.query(['a', 'b', 'c'], 'hello', 2);

    // Best-first across groups, then sliced to k — unchanged by the dedupe.
    expect(results.map((chunk) => chunk.collectionId)).toEqual(['b', 'c']);
  });

  it('forwards the caller k to each collection as its per-collection limit', async () => {
    const rows = [collectionRow('a', 'nomic-embed-text')];
    const registry = new CollectionRegistry(
      asStore(createFakeStore(rows)),
      DEFAULTS,
      'http://x',
      false,
    );
    const { indexers } = instrument(registry, ['a']);
    const indexer = indexers.get('a');
    if (indexer === undefined) throw new Error('missing indexer');
    const query = vi.spyOn(indexer, 'query');

    await registry.query(['a'], 'hello', 3);
    expect(query.mock.calls[0]?.[1]).toBe(3);

    query.mockClear();
    await registry.query(['a'], 'hello');
    expect(query.mock.calls[0]?.[1]).toBe(DEFAULTS.topK);
  });
});
