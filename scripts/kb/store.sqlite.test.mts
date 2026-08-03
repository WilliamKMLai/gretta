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
    store.upsertCollection({ id: 'a', name: 'A', folders: ['/tmp/x'], embeddingModel: 'm1' });
    expect(store.getCollection('a')).toMatchObject({
      id: 'a',
      name: 'A',
      folders: ['/tmp/x'],
      embeddingModel: 'm1',
      lastIndexedAt: null,
    });
  });

  it('stores chunks and recovers embeddings through the float32 blob', () => {
    store.upsertCollection({ id: 'a', name: 'A', folders: [], embeddingModel: 'm1' });
    store.replaceFile('a', 'doc.md', 'h1', [chunk('doc.md', 'hello', [0.5, -0.25, 1])]);
    const rows = store.allChunks(['a']);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.embedding).toEqual([0.5, -0.25, 1]);
    expect(rows[0]?.collectionId).toBe('a');
  });

  it('is the incremental key: hash comparison detects unchanged files', () => {
    store.upsertCollection({ id: 'a', name: 'A', folders: [], embeddingModel: 'm1' });
    const hash = contentHash('same bytes');
    store.replaceFile('a', 'doc.md', hash, [chunk('doc.md', 'v1', [1, 0])]);
    expect(store.fileHash('a', 'doc.md')).toBe(hash);
    expect(store.fileHash('a', 'missing.md')).toBeNull();
    expect(contentHash('same bytes')).toBe(hash);
    expect(contentHash('other bytes')).not.toBe(hash);
  });

  it('replaces a changed file without duplicating its chunks', () => {
    store.upsertCollection({ id: 'a', name: 'A', folders: [], embeddingModel: 'm1' });
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
    store.upsertCollection({ id: 'a', name: 'A', folders: [], embeddingModel: 'm1' });
    store.replaceFile('a', 'one.md', 'h1', [chunk('one.md', 'x', [1, 0])]);
    store.replaceFile('a', 'two.md', 'h2', [chunk('two.md', 'y', [0, 1])]);
    store.removeFile('a', 'one.md');
    expect(store.indexedSources('a')).toEqual(['two.md']);
    expect(store.counts('a')).toEqual({ fileCount: 1, chunkCount: 1 });
  });

  it('invalidates stored vectors when a collection changes embedding model', () => {
    store.upsertCollection({ id: 'a', name: 'A', folders: [], embeddingModel: 'm1' });
    store.replaceFile('a', 'doc.md', 'h1', [chunk('doc.md', 'v1', [1, 0])]);
    store.upsertCollection({ id: 'a', name: 'A', folders: [], embeddingModel: 'm2' });
    expect(store.counts('a')).toEqual({ fileCount: 0, chunkCount: 0 });
    expect(store.getCollection('a')?.embeddingModel).toBe('m2');
  });

  it('keeps vectors when a rename leaves the model untouched', () => {
    store.upsertCollection({ id: 'a', name: 'A', folders: [], embeddingModel: 'm1' });
    store.replaceFile('a', 'doc.md', 'h1', [chunk('doc.md', 'v1', [1, 0])]);
    store.upsertCollection({ id: 'a', name: 'Renamed', folders: ['/new'], embeddingModel: 'm1' });
    expect(store.counts('a')).toEqual({ fileCount: 1, chunkCount: 1 });
  });

  it('scopes chunks per collection and deletes one without touching the other', () => {
    store.upsertCollection({ id: 'a', name: 'A', folders: [], embeddingModel: 'm1' });
    store.upsertCollection({ id: 'b', name: 'B', folders: [], embeddingModel: 'm1' });
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
    first.upsertCollection({ id: 'a', name: 'A', folders: ['/f'], embeddingModel: 'm1' });
    first.replaceFile('a', 'doc.md', 'h1', [chunk('doc.md', 'kept', [1, 0])]);
    first.markIndexed('a', '2026-01-01T00:00:00.000Z');
    first.close();

    const second = new SqliteStore(file);
    expect(second.getCollection('a')?.lastIndexedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(second.allChunks(['a']).map((row) => row.text)).toEqual(['kept']);
    second.close();
  });
});
