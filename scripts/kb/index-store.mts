/**
 * Per-collection indexing pipeline (DECISIONS.md ADR-020).
 *
 * scan → (hash-compare) → parse → chunk → embed → store, then top-k query.
 * Indexing is INCREMENTAL: a file whose content hash matches the stored one is
 * skipped entirely, a changed file has its chunks replaced, and a file that
 * disappeared has its rows dropped. A full rebuild happens only when the
 * collection's embedding model changes (vectors stop being comparable) or the
 * caller asks for one.
 *
 * Ranking is brute-force cosine over the collection's vectors, which is the
 * documented default below the capacity ceiling; sqlite-vec ANN slots in behind
 * `query()` when a corpus actually exceeds it. The ranking matrix (`store.
 * chunkVectors`) is built lazily and cached per instance — every write path
 * invalidates it through `invalidateQueryMatrix`, so a stale cache never
 * outlives the write that would make it wrong.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type {
  CollectionConfig,
  CollectionStatus,
  IndexPhase,
  IndexProgressEvent,
  QueryDefaults,
  RetrievedChunk,
} from '../../src/types/knowledgebase';
import { DEFAULT_CHUNK_OPTIONS, chunkBlocks } from './chunk.mts';
import { EmbedUnreachableError, createEmbedder } from './embedder.mts';
import { isSupported, parseFile } from './parse.mts';
import { topKPacked } from './score.mts';
import { contentHash, type SqliteStore, type StoredChunk } from './store.sqlite.mts';

/** The cached ranking matrix for one collection (ADR-020 amendment). */
interface QueryMatrix {
  matrix: Float32Array;
  rowIds: number[];
  dims: number;
}

/** Capacity ceiling for the fast-ranking readout (ADR-020 post-review: 30 000). */
export const KB_MAX_CHUNKS = 30_000;

/** `chunkCount` as a 0..100+ percentage of the ceiling (>100 signals over). */
export function capacityPct(chunkCount: number, maxChunks = KB_MAX_CHUNKS): number {
  return maxChunks <= 0 ? 0 : Math.round((chunkCount / maxChunks) * 100);
}

type ProgressListener = (event: IndexProgressEvent) => void;

const EMBED_BATCH = 32;

export class CollectionIndexer {
  private config: CollectionConfig;
  private readonly store: SqliteStore;
  private readonly defaults: QueryDefaults;
  private readonly ollamaUrl: string;
  private phase: IndexPhase = 'idle';
  private message: string | null = null;
  private skipped: { path: string; reason: string }[] = [];
  private readonly listeners = new Set<ProgressListener>();
  private runToken = 0;
  private queryMatrix: QueryMatrix | null = null;

  constructor(
    config: CollectionConfig,
    store: SqliteStore,
    defaults: QueryDefaults,
    ollamaUrl: string,
  ) {
    this.config = config;
    this.store = store;
    this.defaults = defaults;
    this.ollamaUrl = ollamaUrl;
    this.phase = config.folders.length === 0 ? 'disabled' : 'idle';
  }

  get id(): string {
    return this.config.id;
  }

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: IndexProgressEvent): void {
    if (event.type === 'phase') this.phase = event.phase;
    for (const listener of this.listeners) listener(event);
  }

  status(): CollectionStatus {
    const { fileCount, chunkCount } = this.store.counts(this.config.id);
    const row = this.store.getCollection(this.config.id);
    return {
      id: this.config.id,
      name: this.config.name,
      folders: [...this.config.folders],
      embeddingModel: this.config.embeddingModel,
      phase: this.phase,
      fileCount,
      chunkCount,
      maxChunks: KB_MAX_CHUNKS,
      capacityPct: capacityPct(chunkCount),
      overCapacity: chunkCount > KB_MAX_CHUNKS,
      skipped: [...this.skipped],
      lastIndexedAt: row?.lastIndexedAt ?? null,
      message: this.message,
    };
  }

  /** Applies new config (persisted) and re-indexes. Supersedes a running build. */
  async setConfig(config: CollectionConfig): Promise<void> {
    this.config = config;
    this.store.upsertCollection({
      id: config.id,
      name: config.name,
      folders: config.folders,
      embeddingModel: config.embeddingModel,
    });
    this.invalidateQueryMatrix(); // upsertCollection may itself clear on a model change
    await this.reindex();
  }

  /** Drops the cached ranking matrix; the next `query()` rebuilds it from the store. */
  private invalidateQueryMatrix(): void {
    this.queryMatrix = null;
  }

  /**
   * Incremental index pass. Only changed/new files are parsed and embedded;
   * vanished files are dropped. `full` clears the collection first.
   */
  async reindex(full = false): Promise<void> {
    const token = ++this.runToken;
    this.skipped = [];
    this.invalidateQueryMatrix();
    if (this.config.folders.length === 0) {
      this.store.clearCollection(this.config.id);
      this.emit({ type: 'phase', phase: 'disabled' });
      return;
    }
    if (full) this.store.clearCollection(this.config.id);

    const embedder = createEmbedder(this.config.embeddingModel, this.ollamaUrl);
    this.emit({ type: 'phase', phase: 'scanning' });
    const files = await this.scanAll();
    if (token !== this.runToken) return;
    this.emit({ type: 'scan', totalFiles: files.length });

    // Files recorded previously but no longer present are removed.
    const present = new Set(files.map((file) => file.source));
    for (const source of this.store.indexedSources(this.config.id)) {
      if (!present.has(source)) {
        this.store.removeFile(this.config.id, source);
        this.invalidateQueryMatrix();
      }
    }

    this.emit({ type: 'phase', phase: 'indexing' });
    let done = 0;
    for (const file of files) {
      if (token !== this.runToken) return;
      done += 1;
      let bytes: Buffer;
      try {
        bytes = await readFile(file.absolute);
      } catch {
        this.skip(file.source, 'could not read file');
        continue;
      }
      const hash = contentHash(bytes);
      if (this.store.fileHash(this.config.id, file.source) === hash) {
        this.emit({ type: 'file', path: file.source, filesDone: done, totalFiles: files.length });
        continue; // unchanged — the whole point of incremental indexing
      }

      const parsed = await parseFile(file.absolute);
      if (!parsed.ok) {
        this.skip(file.source, parsed.reason);
        continue;
      }
      const chunks = chunkBlocks(parsed.blocks, DEFAULT_CHUNK_OPTIONS);
      const stored: StoredChunk[] = [];
      try {
        for (let start = 0; start < chunks.length; start += EMBED_BATCH) {
          if (token !== this.runToken) return;
          const batch = chunks.slice(start, start + EMBED_BATCH);
          const vectors = await embedder.embed(batch.map((chunk) => chunk.text));
          batch.forEach((chunk, i) => {
            stored.push({
              source: file.source,
              page: chunk.page,
              paragraph: chunk.paragraph,
              text: chunk.text,
              embedding: vectors[i] ?? [],
            });
          });
        }
      } catch (error) {
        if (error instanceof EmbedUnreachableError) {
          // Ollama down mid-index is not fatal: report and stop cleanly so the
          // next attempt resumes from what is already stored.
          this.message = error.message;
          this.emit({ type: 'error', path: null, message: error.message });
          this.emit({ type: 'phase', phase: 'ollama-unreachable' });
          return;
        }
        this.skip(file.source, error instanceof Error ? error.message : 'embedding failed');
        continue;
      }
      this.store.replaceFile(this.config.id, file.source, hash, stored);
      this.invalidateQueryMatrix();
      this.emit({ type: 'file', path: file.source, filesDone: done, totalFiles: files.length });
    }

    if (token !== this.runToken) return;
    const { fileCount, chunkCount } = this.store.counts(this.config.id);
    this.store.markIndexed(this.config.id, new Date().toISOString());
    this.message = null;
    this.emit({ type: 'done', chunkCount, fileCount });
    this.emit({ type: 'phase', phase: 'ready' });
  }

  private skip(source: string, reason: string): void {
    this.skipped.push({ path: source, reason });
    this.emit({ type: 'skip', path: source, reason });
  }

  /** Embeds the query and ranks this collection's chunks via the cached matrix. */
  async query(text: string, k?: number): Promise<RetrievedChunk[]> {
    if (text.trim() === '') return [];
    const { matrix, rowIds, dims } = this.getQueryMatrix();
    if (rowIds.length === 0) return [];
    const embedder = createEmbedder(this.config.embeddingModel, this.ollamaUrl);
    const [vector] = await embedder.embed([text]);
    if (vector === undefined) return [];
    const matches = topKPacked(
      Float32Array.from(vector),
      matrix,
      dims,
      rowIds.length,
      k ?? this.defaults.topK,
      this.defaults.minScore,
    );
    if (matches.length === 0) return [];
    // -1 is an impossible rowid (SQLite rowids start at 1); it only surfaces if
    // `match.index` were ever out of range, in which case the lookup below
    // simply misses rather than throwing.
    const rowIdFor = (index: number): number => rowIds[index] ?? -1;
    const winners = matches.map((match) => rowIdFor(match.index));
    const byRowId = new Map(this.store.chunksByRowIds(winners).map((row) => [row.rowId, row]));
    const results: RetrievedChunk[] = [];
    for (const match of matches) {
      const row = byRowId.get(rowIdFor(match.index));
      if (row === undefined) continue; // vanished between the matrix build and this fetch
      results.push({
        collectionId: row.collectionId,
        source: row.source,
        locator: { page: row.page, paragraph: row.paragraph },
        text: row.text,
        score: match.score,
      });
    }
    return results;
  }

  /** Builds (and caches) this collection's ranking matrix on first use after invalidation. */
  private getQueryMatrix(): QueryMatrix {
    this.queryMatrix ??= this.store.chunkVectors([this.config.id]);
    return this.queryMatrix;
  }

  /** Enumerates supported files across every configured folder. */
  private async scanAll(): Promise<{ absolute: string; source: string }[]> {
    const out: { absolute: string; source: string }[] = [];
    const seen = new Set<string>();
    for (const folder of this.config.folders) {
      try {
        if (!(await stat(folder)).isDirectory()) {
          this.skip(folder, 'not a folder');
          continue;
        }
      } catch {
        this.skip(folder, 'folder not found');
        continue;
      }
      const entries = await readdir(folder, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !isSupported(entry.name)) continue;
        const absolute = join(entry.parentPath, entry.name);
        const source = toPosix(relative(folder, absolute));
        if (seen.has(source)) continue; // overlapping folders: first wins
        seen.add(source);
        out.push({ absolute, source });
      }
    }
    return out.sort((a, b) => a.source.localeCompare(b.source));
  }
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}
