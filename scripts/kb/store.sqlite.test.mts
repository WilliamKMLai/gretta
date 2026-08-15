import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore, contentHash, type StoredChunk } from './store.sqlite.mts';

const chunk = (source: string, text: string, embedding: number[]): StoredChunk => ({
  source,
  page: null,
  paragraph: 1,
  text,
  embedding,
});

describe('SqliteStore', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kb-store-'));
    store = new SqliteStore(join(dir, 'kb.sqlite3'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a collection definition', () => {
    store.upsertCollection({
      id: 'a',
      name: 'A',
      folders: ['/tmp/x'],
      embeddingModel: 'm1',
      indexFigures: false,
    });
    expect(store.getCollection('a')).toMatchObject({
      id: 'a',
      name: 'A',
      folders: ['/tmp/x'],
      embeddingModel: 'm1',
      indexFigures: false,
      lastIndexedAt: null,
    });
  });

  it('stores chunks and recovers embeddings through the float32 blob', () => {
    store.upsertCollection({
      id: 'a',
      name: 'A',
      folders: [],
      embeddingModel: 'm1',
      indexFigures: false,
    });
    store.replaceFile('a', 'doc.md', 'h1', [chunk('doc.md', 'hello', [0.5, -0.25, 1])]);
    const rows = store.allChunks(['a']);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.embedding).toEqual([0.5, -0.25, 1]);
    expect(rows[0]?.collectionId).toBe('a');
  });

  it('is the incremental key: hash comparison detects unchanged files', () => {
    store.upsertCollection({
      id: 'a',
      name: 'A',
      folders: [],
      embeddingModel: 'm1',
      indexFigures: false,
    });
    const hash = contentHash('same bytes');
    store.replaceFile('a', 'doc.md', hash, [chunk('doc.md', 'v1', [1, 0])]);
    expect(store.fileHash('a', 'doc.md')).toBe(hash);
    expect(store.fileHash('a', 'missing.md')).toBeNull();
    expect(contentHash('same bytes')).toBe(hash);
    expect(contentHash('other bytes')).not.toBe(hash);
  });

  it('replaces a changed file without duplicating its chunks', () => {
    store.upsertCollection({
      id: 'a',
      name: 'A',
      folders: [],
      embeddingModel: 'm1',
      indexFigures: false,
    });
    store.replaceFile('a', 'doc.md', 'h1', [chunk('doc.md', 'v1', [1, 0])]);
    store.replaceFile('a', 'doc.md', 'h2', [
      chunk('doc.md', 'v2a', [1, 0]),
      chunk('doc.md', 'v2b', [0, 1]),
    ]);
    expect(store.counts('a')).toEqual({ fileCount: 1, chunkCount: 2 });
    expect(store.allChunks(['a']).map((row) => row.text)).toEqual(['v2a', 'v2b']);
    expect(store.fileHash('a', 'doc.md')).toBe('h2');
  });

  it('drops a removed file and reports remaining sources', () => {
    store.upsertCollection({
      id: 'a',
      name: 'A',
      folders: [],
      embeddingModel: 'm1',
      indexFigures: false,
    });
    store.replaceFile('a', 'one.md', 'h1', [chunk('one.md', 'x', [1, 0])]);
    store.replaceFile('a', 'two.md', 'h2', [chunk('two.md', 'y', [0, 1])]);
    store.removeFile('a', 'one.md');
    expect(store.indexedSources('a')).toEqual(['two.md']);
    expect(store.counts('a')).toEqual({ fileCount: 1, chunkCount: 1 });
  });

  it('invalidates stored vectors when a collection changes embedding model', () => {
    store.upsertCollection({
      id: 'a',
      name: 'A',
      folders: [],
      embeddingModel: 'm1',
      indexFigures: false,
    });
    store.replaceFile('a', 'doc.md', 'h1', [chunk('doc.md', 'v1', [1, 0])]);
    store.upsertCollection({
      id: 'a',
      name: 'A',
      folders: [],
      embeddingModel: 'm2',
      indexFigures: false,
    });
    expect(store.counts('a')).toEqual({ fileCount: 0, chunkCount: 0 });
    expect(store.getCollection('a')?.embeddingModel).toBe('m2');
  });

  it('keeps vectors when a rename leaves the model untouched', () => {
    store.upsertCollection({
      id: 'a',
      name: 'A',
      folders: [],
      embeddingModel: 'm1',
      indexFigures: false,
    });
    store.replaceFile('a', 'doc.md', 'h1', [chunk('doc.md', 'v1', [1, 0])]);
    store.upsertCollection({
      id: 'a',
      name: 'Renamed',
      folders: ['/new'],
      embeddingModel: 'm1',
      indexFigures: false,
    });
    expect(store.counts('a')).toEqual({ fileCount: 1, chunkCount: 1 });
  });

  it('scopes chunks per collection and deletes one without touching the other', () => {
    store.upsertCollection({
      id: 'a',
      name: 'A',
      folders: [],
      embeddingModel: 'm1',
      indexFigures: false,
    });
    store.upsertCollection({
      id: 'b',
      name: 'B',
      folders: [],
      embeddingModel: 'm1',
      indexFigures: false,
    });
    store.replaceFile('a', 'a.md', 'h', [chunk('a.md', 'in a', [1, 0])]);
    store.replaceFile('b', 'b.md', 'h', [chunk('b.md', 'in b', [0, 1])]);
    expect(store.allChunks(['a']).map((r) => r.text)).toEqual(['in a']);
    expect(store.allChunks(['a', 'b'])).toHaveLength(2);
    expect(store.allChunks([])).toEqual([]);
    store.deleteCollection('a');
    expect(store.getCollection('a')).toBeNull();
    expect(store.counts('b')).toEqual({ fileCount: 1, chunkCount: 1 });
  });

  it('persists across reopen (survives a companion restart)', () => {
    const file = join(dir, 'persist.sqlite3');
    const first = new SqliteStore(file);
    first.upsertCollection({
      id: 'a',
      name: 'A',
      folders: ['/f'],
      embeddingModel: 'm1',
      indexFigures: false,
    });
    first.replaceFile('a', 'doc.md', 'h1', [chunk('doc.md', 'kept', [1, 0])]);
    first.markIndexed('a', '2026-01-01T00:00:00.000Z');
    first.close();

    const second = new SqliteStore(file);
    expect(second.getCollection('a')?.lastIndexedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(second.allChunks(['a']).map((row) => row.text)).toEqual(['kept']);
    second.close();
  });

  describe('chunkVectors', () => {
    it('L2-normalizes each row and packs them contiguously', () => {
      store.upsertCollection({
        id: 'a',
        name: 'A',
        folders: [],
        embeddingModel: 'm1',
        indexFigures: false,
      });
      store.replaceFile('a', 'doc.md', 'h1', [
        chunk('doc.md', 'one', [3, 4]), // norm 5
        chunk('doc.md', 'two', [0, 2]), // norm 2
      ]);
      const { matrix, rowIds, dims } = store.chunkVectors(['a']);
      expect(dims).toBe(2);
      expect(rowIds).toHaveLength(2);
      const [a0, a1, b0, b1] = Array.from(matrix);
      expect(a0).toBeCloseTo(0.6, 5);
      expect(a1).toBeCloseTo(0.8, 5);
      expect(b0).toBeCloseTo(0, 5);
      expect(b1).toBeCloseTo(1, 5);
    });

    it('leaves a zero vector as zeros instead of dividing by zero', () => {
      store.upsertCollection({
        id: 'a',
        name: 'A',
        folders: [],
        embeddingModel: 'm1',
        indexFigures: false,
      });
      store.replaceFile('a', 'doc.md', 'h1', [chunk('doc.md', 'zero', [0, 0])]);
      const { matrix } = store.chunkVectors(['a']);
      expect(Array.from(matrix)).toEqual([0, 0]);
    });

    it('returns an empty matrix for no collection ids or an empty collection', () => {
      store.upsertCollection({
        id: 'a',
        name: 'A',
        folders: [],
        embeddingModel: 'm1',
        indexFigures: false,
      });
      expect(store.chunkVectors([])).toEqual({ matrix: new Float32Array(0), rowIds: [], dims: 0 });
      expect(store.chunkVectors(['a'])).toEqual({
        matrix: new Float32Array(0),
        rowIds: [],
        dims: 0,
      });
    });

    it('skips rows whose stored dimension disagrees with the first row', () => {
      store.upsertCollection({
        id: 'a',
        name: 'A',
        folders: [],
        embeddingModel: 'm1',
        indexFigures: false,
      });
      // Simulates leftover rows from before a model/dimension change — the store
      // itself doesn't validate embedding length against the declared model.
      store.replaceFile('a', 'one.md', 'h1', [chunk('one.md', 'a', [1, 0, 0])]);
      store.replaceFile('a', 'two.md', 'h2', [chunk('two.md', 'b', [1, 0])]);
      const { rowIds, dims } = store.chunkVectors(['a']);
      expect(dims).toBe(3);
      expect(rowIds).toHaveLength(1);
    });

    it('scopes to the requested collections only', () => {
      store.upsertCollection({
        id: 'a',
        name: 'A',
        folders: [],
        embeddingModel: 'm1',
        indexFigures: false,
      });
      store.upsertCollection({
        id: 'b',
        name: 'B',
        folders: [],
        embeddingModel: 'm1',
        indexFigures: false,
      });
      store.replaceFile('a', 'a.md', 'h', [chunk('a.md', 'in a', [1, 0])]);
      store.replaceFile('b', 'b.md', 'h', [chunk('b.md', 'in b', [0, 1])]);
      expect(store.chunkVectors(['a']).rowIds).toHaveLength(1);
      expect(store.chunkVectors(['a', 'b']).rowIds).toHaveLength(2);
    });
  });

  describe('chunksByRowIds', () => {
    it('round-trips rowids from chunkVectors back to full rows', () => {
      store.upsertCollection({
        id: 'a',
        name: 'A',
        folders: [],
        embeddingModel: 'm1',
        indexFigures: false,
      });
      store.replaceFile('a', 'doc.md', 'h1', [
        chunk('doc.md', 'first chunk', [1, 0]),
        chunk('doc.md', 'second chunk', [0, 1]),
      ]);
      const { rowIds } = store.chunkVectors(['a']);
      const rows = store.chunksByRowIds(rowIds);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.text).sort()).toEqual(['first chunk', 'second chunk']);
      expect(rows.every((r) => r.collectionId === 'a')).toBe(true);
    });

    it('returns [] for an empty rowid list and silently skips ids that no longer exist', () => {
      store.upsertCollection({
        id: 'a',
        name: 'A',
        folders: [],
        embeddingModel: 'm1',
        indexFigures: false,
      });
      store.replaceFile('a', 'doc.md', 'h1', [chunk('doc.md', 'x', [1, 0])]);
      expect(store.chunksByRowIds([])).toEqual([]);
      const { rowIds } = store.chunkVectors(['a']);
      expect(store.chunksByRowIds([...rowIds, 999_999])).toHaveLength(1);
    });
  });
});
