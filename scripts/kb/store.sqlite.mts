/**
 * Durable chunk + vector storage (DECISIONS.md ADR-020).
 *
 * One SQLite file under the data directory holds every collection. Chunks are
 * keyed by (collection, source path, content hash), which is exactly what makes
 * indexing incremental: a file whose hash is unchanged is skipped without being
 * re-read, re-chunked, or re-embedded; a changed file has its rows replaced;
 * a deleted file has its rows dropped. Embeddings are stored as float32 blobs
 * (~3 KB at 768 dims), so a 30 000-chunk collection is ~90 MB. `chunkVectors`
 * packs those blobs into one normalized matrix for `topKPacked` (score.mts)
 * to scan; that path ranks in low-tens-of-ms at the ADR-020 ceiling, why
 * brute-force cosine is the default and sqlite-vec stays deferred. `allChunks`
 * decodes every row into a boxed `number[]` instead — kept for callers that
 * need that shape, but it is not the fast path.
 *
 * The embedding model is recorded per collection: vectors from different models
 * are not comparable, so a model change invalidates that collection's rows and
 * forces a rebuild (the guardrail behind "configurable embedding model").
 *
 * `tex_macro_state` (ADR-020 amendment, folder-scoped `.tex` macro expansion)
 * records the folder macro table's fingerprint at each collection's last
 * reindex, so index-store.mts can tell when the table changed and force a
 * re-embed of every `.tex` file rather than trusting their individual,
 * unchanged content hashes — a macro redefinition in one file can change
 * what another file's chunks should say without that file's own bytes
 * changing at all.
 */
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { createHash } from 'node:crypto';

/** A chunk as stored: text, provenance, and its vector. */
export interface StoredChunk {
  source: string;
  page: number | null;
  paragraph: number | null;
  text: string;
  embedding: number[];
}

/** A stored chunk's row, identified by rowid, without its vector. */
export interface ChunkRow {
  rowId: number;
  collectionId: string;
  source: string;
  page: number | null;
  paragraph: number | null;
  text: string;
}

/** Content hash of a file's bytes — the incremental-indexing key. */
export function contentHash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

function toBlob(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

function fromBlob(blob: Buffer): number[] {
  const floats = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(floats);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS collections (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  folders        TEXT NOT NULL,
  embeddingModel TEXT NOT NULL,
  lastIndexedAt  TEXT
);
CREATE TABLE IF NOT EXISTS files (
  collectionId TEXT NOT NULL,
  source       TEXT NOT NULL,
  hash         TEXT NOT NULL,
  PRIMARY KEY (collectionId, source)
);
CREATE TABLE IF NOT EXISTS chunks (
  collectionId TEXT NOT NULL,
  source       TEXT NOT NULL,
  page         INTEGER,
  paragraph    INTEGER,
  text         TEXT NOT NULL,
  embedding    BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_by_collection ON chunks (collectionId);
CREATE INDEX IF NOT EXISTS chunks_by_source ON chunks (collectionId, source);
CREATE TABLE IF NOT EXISTS tex_macro_state (
  collectionId   TEXT PRIMARY KEY,
  macroTableHash TEXT NOT NULL
);
`;

/** Persisted collection row (folders stored as JSON). */
export interface CollectionRow {
  id: string;
  name: string;
  folders: string[];
  embeddingModel: string;
  lastIndexedAt: string | null;
}

/** SQLite-backed store; one instance per companion process. */
export class SqliteStore {
  private readonly db: Database;

  constructor(filename: string) {
    this.db = new DatabaseConstructor(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  listCollections(): CollectionRow[] {
    const rows = this.db.prepare('SELECT * FROM collections ORDER BY name').all() as {
      id: string;
      name: string;
      folders: string;
      embeddingModel: string;
      lastIndexedAt: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      folders: JSON.parse(row.folders) as string[],
      embeddingModel: row.embeddingModel,
      lastIndexedAt: row.lastIndexedAt,
    }));
  }

  getCollection(id: string): CollectionRow | null {
    return this.listCollections().find((row) => row.id === id) ?? null;
  }

  upsertCollection(row: Omit<CollectionRow, 'lastIndexedAt'>): void {
    const previous = this.getCollection(row.id);
    this.db
      .prepare(
        `INSERT INTO collections (id, name, folders, embeddingModel, lastIndexedAt)
         VALUES (@id, @name, @folders, @embeddingModel, NULL)
         ON CONFLICT(id) DO UPDATE SET
           name = @name, folders = @folders, embeddingModel = @embeddingModel`,
      )
      .run({ ...row, folders: JSON.stringify(row.folders) });
    // Vectors from a different model are not comparable — drop and rebuild.
    if (previous !== null && previous.embeddingModel !== row.embeddingModel) {
      this.clearCollection(row.id);
    }
  }

  deleteCollection(id: string): void {
    this.clearCollection(id);
    this.db.prepare('DELETE FROM tex_macro_state WHERE collectionId = ?').run(id);
    this.db.prepare('DELETE FROM collections WHERE id = ?').run(id);
  }

  /** Drops indexed content but keeps the collection definition. */
  clearCollection(id: string): void {
    this.db.prepare('DELETE FROM chunks WHERE collectionId = ?').run(id);
    this.db.prepare('DELETE FROM files WHERE collectionId = ?').run(id);
  }

  markIndexed(id: string, isoTimestamp: string): void {
    this.db.prepare('UPDATE collections SET lastIndexedAt = ? WHERE id = ?').run(isoTimestamp, id);
  }

  /** Hash recorded for a source at last index, or null when never indexed. */
  fileHash(collectionId: string, source: string): string | null {
    const row = this.db
      .prepare('SELECT hash FROM files WHERE collectionId = ? AND source = ?')
      .get(collectionId, source) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  /** Sources currently recorded for a collection (to detect deletions). */
  indexedSources(collectionId: string): string[] {
    const rows = this.db
      .prepare('SELECT source FROM files WHERE collectionId = ?')
      .all(collectionId) as { source: string }[];
    return rows.map((row) => row.source);
  }

  /** The folder `.tex` macro table's fingerprint as of the last reindex, or
   * null when never recorded — a fresh collection, or one indexed before
   * this feature existed. Either way, null is treated as "changed" by the
   * caller, so `.tex` files get one corrective re-embed. */
  getTexMacroHash(collectionId: string): string | null {
    const row = this.db
      .prepare('SELECT macroTableHash FROM tex_macro_state WHERE collectionId = ?')
      .get(collectionId) as { macroTableHash: string } | undefined;
    return row?.macroTableHash ?? null;
  }

  /** Records the folder `.tex` macro table's fingerprint for this collection. */
  setTexMacroHash(collectionId: string, hash: string): void {
    this.db
      .prepare(
        `INSERT INTO tex_macro_state (collectionId, macroTableHash) VALUES (?, ?)
         ON CONFLICT(collectionId) DO UPDATE SET macroTableHash = excluded.macroTableHash`,
      )
      .run(collectionId, hash);
  }

  /** Replaces one file's chunks atomically and records its new hash. */
  replaceFile(collectionId: string, source: string, hash: string, chunks: StoredChunk[]): void {
    const insertChunk = this.db.prepare(
      `INSERT INTO chunks (collectionId, source, page, paragraph, text, embedding)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const run = this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM chunks WHERE collectionId = ? AND source = ?')
        .run(collectionId, source);
      for (const chunk of chunks) {
        insertChunk.run(
          collectionId,
          source,
          chunk.page,
          chunk.paragraph,
          chunk.text,
          toBlob(chunk.embedding),
        );
      }
      this.db
        .prepare(
          `INSERT INTO files (collectionId, source, hash) VALUES (?, ?, ?)
           ON CONFLICT(collectionId, source) DO UPDATE SET hash = excluded.hash`,
        )
        .run(collectionId, source, hash);
    });
    run();
  }

  /** Removes a source that disappeared from the watched folders. */
  removeFile(collectionId: string, source: string): void {
    const run = this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM chunks WHERE collectionId = ? AND source = ?')
        .run(collectionId, source);
      this.db
        .prepare('DELETE FROM files WHERE collectionId = ? AND source = ?')
        .run(collectionId, source);
    });
    run();
  }

  counts(collectionId: string): { fileCount: number; chunkCount: number } {
    const files = this.db
      .prepare('SELECT COUNT(*) AS n FROM files WHERE collectionId = ?')
      .get(collectionId) as { n: number };
    const chunks = this.db
      .prepare('SELECT COUNT(*) AS n FROM chunks WHERE collectionId = ?')
      .get(collectionId) as { n: number };
    return { fileCount: files.n, chunkCount: chunks.n };
  }

  /** Every chunk of the given collections, for brute-force cosine ranking. */
  allChunks(collectionIds: string[]): (StoredChunk & { collectionId: string })[] {
    if (collectionIds.length === 0) return [];
    const placeholders = collectionIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT collectionId, source, page, paragraph, text, embedding
         FROM chunks WHERE collectionId IN (${placeholders})`,
      )
      .all(...collectionIds) as {
      collectionId: string;
      source: string;
      page: number | null;
      paragraph: number | null;
      text: string;
      embedding: Buffer;
    }[];
    return rows.map((row) => ({
      collectionId: row.collectionId,
      source: row.source,
      page: row.page,
      paragraph: row.paragraph,
      text: row.text,
      embedding: fromBlob(row.embedding),
    }));
  }

  /**
   * Packs vectors into one L2-normalized matrix for `topKPacked` (score.mts).
   * `dims` comes from the first row; a row whose blob length disagrees is
   * skipped (predates an embedding-model change — ADR-020). A zero vector is
   * left as zeros (not normalized), which then scores 0 against anything.
   */
  chunkVectors(collectionIds: string[]): { matrix: Float32Array; rowIds: number[]; dims: number } {
    if (collectionIds.length === 0) return { matrix: new Float32Array(0), rowIds: [], dims: 0 };
    const placeholders = collectionIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT rowid AS rowId, embedding FROM chunks WHERE collectionId IN (${placeholders})`,
      )
      .all(...collectionIds) as { rowId: number; embedding: Buffer }[];
    if (rows.length === 0) return { matrix: new Float32Array(0), rowIds: [], dims: 0 };

    const dims = (rows[0]?.embedding.byteLength ?? 0) / 4;
    const rowIds: number[] = [];
    const blobs: Buffer[] = [];
    for (const row of rows) {
      if (row.embedding.byteLength / 4 !== dims) continue; // mismatched dims: predates a model change
      rowIds.push(row.rowId);
      blobs.push(row.embedding);
    }

    const matrix = new Float32Array(rowIds.length * dims);
    blobs.forEach((blob, i) => {
      const floats = new Float32Array(blob.buffer, blob.byteOffset, dims);
      let norm = 0;
      for (let d = 0; d < dims; d += 1) norm += (floats[d] ?? 0) * (floats[d] ?? 0);
      norm = Math.sqrt(norm);
      if (norm === 0) return;
      const base = i * dims;
      for (let d = 0; d < dims; d += 1) matrix[base + d] = (floats[d] ?? 0) / norm;
    });
    return { matrix, rowIds, dims };
  }

  /** Full rows (including `text`, excluding the vector) for the given rowids — the top-k survivors. */
  chunksByRowIds(rowIds: number[]): ChunkRow[] {
    if (rowIds.length === 0) return [];
    const placeholders = rowIds.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT rowid AS rowId, collectionId, source, page, paragraph, text
         FROM chunks WHERE rowid IN (${placeholders})`,
      )
      .all(...rowIds) as ChunkRow[];
  }
}
