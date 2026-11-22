import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionConfig, QueryDefaults } from '../../src/types/knowledgebase';
import { CollectionIndexer, KB_MAX_CHUNKS, capacityPct } from './index-store.mts';
import { contentHash } from './store.sqlite.mts';
import type { ChunkRow, SqliteStore, StoredFigure } from './store.sqlite.mts';
import { fingerprintMacroTable } from './tex/macros.mts';

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
  return {
    id: 'a',
    name: 'A',
    folders: [],
    embeddingModel: 'm1',
    indexFigures: false,
    ...overrides,
  };
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
    getTexMacroHash: vi.fn(() => null as string | null),
    setTexMacroHash: vi.fn(),
    chunkVectors: vi.fn(() => ({ matrix: new Float32Array(0), rowIds: [] as number[], dims: 0 })),
    replaceFigures: vi.fn(),
    figureCounts: vi.fn(() => ({ total: 0, described: 0 })),
    getFigure: vi.fn((): StoredFigure | null => null),
    saveFigureImage: vi.fn(),
    saveFigureDescription: vi.fn(),
    updateChunkForFigure: vi.fn(),
    undescribedFigures: vi.fn(() => []),
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
    vi.restoreAllMocks();
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

  it('reindex() recurses into sub-folders, not just the top-level folder', async () => {
    vi.stubEnv('GRETTA_KB_FAKE_EMBED', '1');
    dir = mkdtempSync(join(tmpdir(), 'kb-index-'));
    mkdirSync(join(dir, 'sub', 'deeper'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'deeper', 'nested.txt'), 'Nested content.');
    const store = createFakeStore({ fileHash: null });
    const indexer = new CollectionIndexer(
      config({ folders: [dir] }),
      asStore(store),
      DEFAULTS,
      'http://x',
    );

    await indexer.reindex();

    expect(store.replaceFile).toHaveBeenCalledWith(
      'a',
      'sub/deeper/nested.txt',
      expect.any(String),
      expect.anything(),
    );
  });

  it("a changed folder .tex macro table forces a re-embed even when the file's own hash is unchanged", async () => {
    vi.stubEnv('GRETTA_KB_FAKE_EMBED', '1');
    dir = mkdtempSync(join(tmpdir(), 'kb-index-'));
    const texPath = join(dir, 'note.tex');
    writeFileSync(texPath, '\\begin{document}\nSome unchanging prose.\n\\end{document}');
    const store = createFakeStore({ fileHash: contentHash(readFileSync(texPath)) });
    store.getTexMacroHash.mockReturnValue(
      'a-fingerprint-from-a-previous-run-that-no-longer-matches',
    );
    const indexer = new CollectionIndexer(
      config({ folders: [dir] }),
      asStore(store),
      DEFAULTS,
      'http://x',
    );

    await indexer.reindex();

    // The file's own content hash matched what was stored, yet it was still
    // reprocessed — the whole point of the bypass.
    expect(store.replaceFile).toHaveBeenCalled();
    expect(store.setTexMacroHash).toHaveBeenCalledWith('a', expect.any(String));
  });

  it('an unchanged folder .tex macro table lets an unchanged .tex file skip re-embedding, same as any other format', async () => {
    vi.stubEnv('GRETTA_KB_FAKE_EMBED', '1');
    dir = mkdtempSync(join(tmpdir(), 'kb-index-'));
    const texPath = join(dir, 'note.tex');
    writeFileSync(texPath, '\\begin{document}\nSome unchanging prose.\n\\end{document}');
    const store = createFakeStore({ fileHash: contentHash(readFileSync(texPath)) });
    // This file defines no macros, so the folder table is always empty and
    // its fingerprint is stable across runs — recording that exact
    // fingerprint as "already current" means nothing changed.
    store.getTexMacroHash.mockReturnValue(fingerprintMacroTable(new Map()));
    const indexer = new CollectionIndexer(
      config({ folders: [dir] }),
      asStore(store),
      DEFAULTS,
      'http://x',
    );

    await indexer.reindex();

    expect(store.replaceFile).not.toHaveBeenCalled();
  });

  it('defers setTexMacroHash when Ollama is unreachable so the next reindex retries .tex files', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    dir = mkdtempSync(join(tmpdir(), 'kb-index-'));
    writeFileSync(
      join(dir, 'main.tex'),
      '\\newcommand{\\dsize}{42}\n\\begin{document}\nN=\\dsize{}.\n\\end{document}',
    );
    const store = createFakeStore({ fileHash: null });
    const indexer = new CollectionIndexer(
      config({ folders: [dir] }),
      asStore(store),
      DEFAULTS,
      'http://127.0.0.1:11434',
    );

    await indexer.reindex();

    expect(indexer.status().phase).toBe('ollama-unreachable');
    expect(store.setTexMacroHash).not.toHaveBeenCalled();
  });

  it('cancelling mid-embed prevents store.replaceFile from writing orphaned chunks', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kb-index-'));
    writeFileSync(join(dir, 'doc.txt'), 'Hello world.');
    const store = createFakeStore({ fileHash: null });
    const indexer = new CollectionIndexer(
      config({ folders: [dir] }),
      asStore(store),
      DEFAULTS,
      'http://127.0.0.1:11434',
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      indexer.cancel();
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ embeddings: [[1, 0]] }),
      } as Response);
    });

    await indexer.reindex();

    expect(store.replaceFile).not.toHaveBeenCalled();
    expect(store.markIndexed).not.toHaveBeenCalled();
  });

  it('isolates an unreadable subfolder in scanAll() while indexing readable siblings', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    vi.stubEnv('GRETTA_KB_FAKE_EMBED', '1');
    dir = mkdtempSync(join(tmpdir(), 'kb-index-'));
    const locked = join(dir, 'locked');
    const readable = join(dir, 'readable');
    mkdirSync(locked, { recursive: true });
    mkdirSync(readable, { recursive: true });
    writeFileSync(join(locked, 'secret.txt'), 'Hidden.');
    writeFileSync(join(readable, 'ok.txt'), 'Visible.');
    chmodSync(locked, 0o000);
    try {
      const store = createFakeStore({ fileHash: null });
      const indexer = new CollectionIndexer(
        config({ folders: [dir] }),
        asStore(store),
        DEFAULTS,
        'http://x',
      );

      await indexer.reindex();

      expect(indexer.status().phase).toBe('ready');
      expect(indexer.status().skipped).toEqual([expect.objectContaining({ path: 'locked' })]);
      expect(store.replaceFile).toHaveBeenCalledWith(
        'a',
        'readable/ok.txt',
        expect.any(String),
        expect.anything(),
      );
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('transitions to phase "error" instead of rejecting on an unexpected store failure', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kb-index-'));
    const store = createFakeStore();
    store.indexedSources.mockImplementation(() => {
      throw new Error('disk io error');
    });
    const indexer = new CollectionIndexer(
      config({ folders: [dir] }),
      asStore(store),
      DEFAULTS,
      'http://x',
    );

    await expect(indexer.reindex()).resolves.toBeUndefined();
    expect(indexer.status().phase).toBe('error');
    expect(indexer.status().message).toBe('disk io error');
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

describe('CollectionIndexer query-embedding dedupe seam', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A store with one 2-dim chunk, so `query()` gets past its empty-matrix return. */
  function storeWithOneChunk(): ReturnType<typeof createFakeStore> {
    const store = createFakeStore();
    store.chunkVectors.mockReturnValue({
      matrix: Float32Array.from([1, 0]),
      rowIds: [10],
      dims: 2,
    });
    store.chunksByRowIds.mockImplementation((rowIds: number[]) =>
      rowIds.map((rowId): ChunkRow => ({
        rowId,
        collectionId: 'a',
        source: 'doc.md',
        page: null,
        paragraph: 1,
        text: 'chunk text',
      })),
    );
    return store;
  }

  it('exposes embeddingModel and folders without touching the store', () => {
    const store = createFakeStore();
    const indexer = new CollectionIndexer(
      config({ embeddingModel: 'nomic-embed-text', folders: ['/refs/a', '/refs/b'] }),
      asStore(store),
      DEFAULTS,
      'http://x',
    );
    expect(indexer.embeddingModel).toBe('nomic-embed-text');
    expect(indexer.folders).toEqual(['/refs/a', '/refs/b']);
    expect(store.counts).not.toHaveBeenCalled();
  });

  it('reports hasChunks from the matrix, false when the collection is empty', () => {
    const empty = new CollectionIndexer(config(), asStore(createFakeStore()), DEFAULTS, 'http://x');
    expect(empty.hasChunks).toBe(false);

    const filled = new CollectionIndexer(
      config(),
      asStore(storeWithOneChunk()),
      DEFAULTS,
      'http://x',
    );
    expect(filled.hasChunks).toBe(true);
  });

  it('embedQuery returns null for blank text without reaching the embedder', async () => {
    // No GRETTA_KB_FAKE_EMBED and an unreachable URL: an attempted embed would
    // throw, so returning null proves the blank-text guard ran first.
    const indexer = new CollectionIndexer(
      config(),
      asStore(createFakeStore()),
      DEFAULTS,
      'http://x',
    );
    await expect(indexer.embedQuery('   ')).resolves.toBeNull();
  });

  it('query() given a precomputed vector does not embed for itself', async () => {
    const indexer = new CollectionIndexer(
      config(),
      asStore(storeWithOneChunk()),
      DEFAULTS,
      'http://x',
    );
    const embedQuery = vi.spyOn(indexer, 'embedQuery');

    const results = await indexer.query('hello', 8, [1, 0]);

    expect(embedQuery).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]?.text).toBe('chunk text');
  });

  it('query() still embeds for itself when no vector is supplied', async () => {
    vi.stubEnv('GRETTA_KB_FAKE_EMBED', '1');
    const indexer = new CollectionIndexer(
      config(),
      asStore(storeWithOneChunk()),
      DEFAULTS,
      'http://x',
    );
    const embedQuery = vi.spyOn(indexer, 'embedQuery');

    await indexer.query('hello');

    expect(embedQuery).toHaveBeenCalledTimes(1);
    expect(embedQuery).toHaveBeenCalledWith('hello');
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

describe('CollectionIndexer on-demand figure description safety', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function cachedStoredFigure(): StoredFigure {
    return {
      id: 'fig-1',
      collectionId: 'a',
      source: 'paper.pdf',
      contentHash: 'h1',
      page: 1,
      bbox: '{"x0":0,"y0":0,"x1":100,"y1":100}',
      caption: 'Figure 1. Dose curve.',
      description: null,
      mediaType: 'image/png',
      width: 100,
      height: 100,
      bytes: Buffer.from('png'),
      describedAt: null,
    };
  }

  it('deduplicates concurrent detached describeFigure runs for the same figureId', async () => {
    const store = createFakeStore();
    store.getFigure.mockReturnValue(cachedStoredFigure());
    const chatGate: { finish: ((res: Response) => void) | null } = { finish: null };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : '';
      if (url.endsWith('/api/chat')) {
        return new Promise<Response>((resolve) => {
          chatGate.finish = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ embeddings: [[1, 0]] }),
      } as Response);
    });
    const indexer = new CollectionIndexer(config(), asStore(store), DEFAULTS, 'http://x');

    await indexer.figureImage('fig-1', 'qwen2.5vl:7b');
    await indexer.figureImage('fig-1', 'qwen2.5vl:7b');

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    if (chatGate.finish === null) throw new Error('expected /api/chat call');
    chatGate.finish({
      ok: true,
      json: () => Promise.resolve({ message: { content: 'Axes show dose vs response.' } }),
    } as Response);

    await vi.waitFor(() => {
      expect(store.updateChunkForFigure).toHaveBeenCalledTimes(1);
    });
    expect(store.saveFigureDescription).toHaveBeenCalledTimes(1);
  });

  it('discards an in-flight figure description if cancel() runs before completion', async () => {
    const store = createFakeStore();
    store.getFigure.mockReturnValue(cachedStoredFigure());
    const chatGate: { finish: ((res: Response) => void) | null } = { finish: null };
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return new Promise<Response>((resolve) => {
        chatGate.finish = resolve;
      });
    });
    const indexer = new CollectionIndexer(config(), asStore(store), DEFAULTS, 'http://x');

    await indexer.figureImage('fig-1', 'qwen2.5vl:7b');
    indexer.cancel();

    if (chatGate.finish === null) throw new Error('expected /api/chat call');
    chatGate.finish({
      ok: true,
      json: () => Promise.resolve({ message: { content: 'Stale description.' } }),
    } as Response);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(store.saveFigureDescription).not.toHaveBeenCalled();
    expect(store.updateChunkForFigure).not.toHaveBeenCalled();
  });
});
