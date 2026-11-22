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
import type { Dirent } from 'node:fs';
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
import { createDescriber } from './describer.mts';
import { describeFigure, materializeFigure, sourceResolver } from './figure-service.mts';
import type { FigureContext, FigureImageResult } from './figure-service.mts';
import { isSupported, parseFile } from './parse.mts';
import { topKPacked } from './score.mts';
import { contentHash, type SqliteStore, type StoredChunk } from './store.sqlite.mts';
import { buildMacroTable, fingerprintMacroTable, type MacroTable } from './tex/index.mts';

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
  private reindexAbort: AbortController | null = null;
  private describeEpoch = 0;
  private describeAbort = new AbortController();
  private readonly describingFigures = new Set<string>();
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

  /** Configured source folders in memory — lets `registry.arm()` avoid SQL queries. */
  get folders(): readonly string[] {
    return this.config.folders;
  }

  /** This collection's embedding model — the registry's grouping key for query dedupe. */
  get embeddingModel(): string {
    return this.config.embeddingModel;
  }

  /**
   * True when this collection has queryable chunks. Lets the registry skip
   * embedding a group whose collections are all empty: an empty collection
   * returns before embedding in `query()` below, so it cost no embed call
   * before the dedupe and must not start costing one now.
   */
  get hasChunks(): boolean {
    return this.getQueryMatrix().rowIds.length > 0;
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
    const figures = this.store.figureCounts(this.config.id);
    const row = this.store.getCollection(this.config.id);
    return {
      id: this.config.id,
      name: this.config.name,
      folders: [...this.config.folders],
      embeddingModel: this.config.embeddingModel,
      indexFigures: this.config.indexFigures,
      figureCount: figures.total,
      describedFigureCount: figures.described,
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
    const resetDescriptions =
      this.config.embeddingModel !== config.embeddingModel ||
      this.config.indexFigures !== config.indexFigures ||
      config.folders.length === 0;
    this.config = config;
    if (resetDescriptions) this.resetDescribeScope();
    this.store.upsertCollection({
      id: config.id,
      indexFigures: config.indexFigures,
      name: config.name,
      folders: config.folders,
      embeddingModel: config.embeddingModel,
    });
    this.invalidateQueryMatrix(); // upsertCollection may itself clear on a model change
    await this.reindex();
  }

  /** Invalidates any in-flight `reindex()` or `describeFigure()` work. */
  cancel(): void {
    this.runToken += 1;
    this.reindexAbort?.abort();
    this.reindexAbort = null;
    this.resetDescribeScope();
  }

  private resetDescribeScope(): void {
    this.describeEpoch += 1;
    this.describeAbort.abort();
    this.describeAbort = new AbortController();
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
    this.reindexAbort?.abort();
    const abort = new AbortController();
    this.reindexAbort = abort;
    if (full || this.config.folders.length === 0) this.resetDescribeScope();
    this.skipped = [];
    this.invalidateQueryMatrix();
    try {
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

      // Pass 1 (ADR-020 amendment, folder-scoped .tex macro expansion): build
      // the folder's macro table once per reindex from every .tex file in
      // scope. Persist its fingerprint only after the file loop finishes with
      // no interrupted/skipped .tex files, so an aborted or offline run never
      // marks stale .tex chunks as up to date.
      const texFiles = files.filter((file) => file.source.toLowerCase().endsWith('.tex'));
      let texMacros: MacroTable = new Map();
      let texTableChanged = false;
      let pendingTexFingerprint: string | null = null;
      let texSkipped = false;
      if (texFiles.length > 0) {
        const built = await buildMacroTable(texFiles);
        if (token !== this.runToken) return;
        texMacros = built.table;
        for (const warning of built.warnings) {
          console.warn(`[kb:${this.config.id}] ${warning}`);
          this.emit({ type: 'error', path: null, message: warning });
        }
        const fingerprint = fingerprintMacroTable(texMacros);
        texTableChanged = this.store.getTexMacroHash(this.config.id) !== fingerprint;
        pendingTexFingerprint = fingerprint;
      }

      this.emit({ type: 'phase', phase: 'indexing' });
      let done = 0;
      for (const file of files) {
        if (token !== this.runToken) return;
        done += 1;
        const isTex = file.source.toLowerCase().endsWith('.tex');
        let bytes: Buffer;
        try {
          bytes = await readFile(file.absolute);
        } catch {
          if (isTex) texSkipped = true;
          this.skip(file.source, 'could not read file');
          continue;
        }
        const hash = contentHash(bytes);
        const unchanged = this.store.fileHash(this.config.id, file.source) === hash;
        if (unchanged && !(isTex && texTableChanged)) {
          this.emit({ type: 'file', path: file.source, filesDone: done, totalFiles: files.length });
          continue; // unchanged — the whole point of incremental indexing
        }

        const parsed = await parseFile(file.absolute, {
          texMacros,
          // Passing the hash is what enables figure detection (ADR-036); a
          // collection with figures off simply does not pass it.
          ...(this.config.indexFigures ? { contentHash: hash } : {}),
        });
        if (token !== this.runToken) return;
        if (!parsed.ok) {
          if (isTex) texSkipped = true;
          this.skip(file.source, parsed.reason);
          continue;
        }
        const chunks = chunkBlocks(parsed.blocks, DEFAULT_CHUNK_OPTIONS);
        const stored: StoredChunk[] = [];
        try {
          for (let start = 0; start < chunks.length; start += EMBED_BATCH) {
            if (token !== this.runToken) return;
            const batch = chunks.slice(start, start + EMBED_BATCH);
            const vectors = await embedder.embed(
              batch.map((chunk) => chunk.text),
              abort.signal,
            );
            batch.forEach((chunk, i) => {
              stored.push({
                source: file.source,
                page: chunk.page,
                paragraph: chunk.paragraph,
                text: chunk.text,
                embedding: vectors[i] ?? [],
                figureId: chunk.figureId ?? null,
              });
            });
          }
        } catch (error) {
          if (token !== this.runToken) return;
          if (error instanceof EmbedUnreachableError) {
            // Ollama down mid-index is not fatal: report and stop cleanly so the
            // next attempt resumes from what is already stored.
            this.message = error.message;
            this.emit({ type: 'error', path: null, message: error.message });
            this.emit({ type: 'phase', phase: 'ollama-unreachable' });
            return;
          }
          if (isTex) texSkipped = true;
          this.skip(file.source, error instanceof Error ? error.message : 'embedding failed');
          continue;
        }
        if (token !== this.runToken) return;
        this.store.replaceFile(this.config.id, file.source, hash, stored);
        // Recorded from the caption alone — no canvas, no vision model. Pixels
        // and descriptions arrive only when something asks (ADR-036). Skipped
        // outright when the collection has figures off, so a text-only corpus
        // pays no transaction per file.
        if (this.config.indexFigures) {
          this.store.replaceFigures(
            this.config.id,
            file.source,
            (parsed.figures ?? []).map((found) => ({
              id: found.id,
              collectionId: this.config.id,
              source: file.source,
              contentHash: hash,
              page: found.anchor.page,
              bbox: JSON.stringify(found.anchor.region),
              caption: found.anchor.caption,
              description: null,
              mediaType: null,
              width: null,
              height: null,
              bytes: null,
              describedAt: null,
            })),
          );
        }
        this.invalidateQueryMatrix();
        this.emit({ type: 'file', path: file.source, filesDone: done, totalFiles: files.length });
      }

      if (token !== this.runToken) return;
      if (pendingTexFingerprint !== null && !texSkipped) {
        this.store.setTexMacroHash(this.config.id, pendingTexFingerprint);
      }
      const { fileCount, chunkCount } = this.store.counts(this.config.id);
      this.store.markIndexed(this.config.id, new Date().toISOString());
      this.message = null;
      this.emit({ type: 'done', chunkCount, fileCount });
      this.emit({ type: 'phase', phase: 'ready' });
    } catch (error) {
      if (token !== this.runToken) return;
      const detail = error instanceof Error ? error.message : 'index failed';
      this.message = detail;
      this.emit({ type: 'error', path: null, message: detail });
      this.emit({ type: 'phase', phase: 'error' });
    }
  }

  private skip(source: string, reason: string): void {
    this.skipped.push({ path: source, reason });
    this.emit({ type: 'skip', path: source, reason });
  }

  /**
   * Embeds free-form query text with this collection's model. Split out of
   * `query()` so the registry can embed once per distinct model and share the
   * vector across every collection using it — an embedding is a pure function
   * of (model, text), so collections that declare the same model would each
   * have computed exactly this. An embed failure still throws.
   */
  /**
   * A figure's pixels, rendering them if this is the first request (ADR-036).
   *
   * The description is kicked off but never awaited: the caller needs the
   * picture now, and the vision model it is about to reach is going to read
   * that picture directly. Describing first would be the same work twice, at
   * roughly 16 seconds of extra latency, to produce text this answer does not
   * need. It runs detached so the *next* search finds this figure better.
   */
  async figureImage(figureId: string, visionModel: string): Promise<FigureImageResult | null> {
    const figure = this.store.getFigure(this.config.id, figureId);
    if (figure === null) return null;

    const modelAtStart = this.config.embeddingModel;
    const epochAtStart = this.describeEpoch;
    const signal = this.describeAbort.signal;
    const context: FigureContext = {
      collectionId: this.config.id,
      resolveSource: sourceResolver(this.config.folders),
      embedder: createEmbedder(modelAtStart, this.ollamaUrl),
      describer: createDescriber(visionModel, this.ollamaUrl),
      signal,
      canCommit: () =>
        this.describeEpoch === epochAtStart &&
        this.config.embeddingModel === modelAtStart &&
        this.store.getFigure(this.config.id, figureId) !== null,
      invalidate: () => {
        this.invalidateQueryMatrix();
      },
    };

    const image = await materializeFigure(this.store, context, figure);
    if (image === null) return null;

    if (
      figure.describedAt === null &&
      visionModel !== '' &&
      !this.describingFigures.has(figureId)
    ) {
      this.describingFigures.add(figureId);
      void describeFigure(this.store, context, figure, image.dataBase64)
        .catch(() => {
          // Already swallowed inside; this guard only stops an unhandled
          // rejection from taking down the companion.
        })
        .finally(() => {
          this.describingFigures.delete(figureId);
        });
    }
    return image;
  }

  async embedQuery(text: string): Promise<number[] | null> {
    if (text.trim() === '') return null;
    const embedder = createEmbedder(this.config.embeddingModel, this.ollamaUrl);
    const [vector] = await embedder.embed([text]);
    return vector ?? null;
  }

  /**
   * Ranks this collection's chunks via the cached matrix. `precomputedVector`
   * is the registry's dedupe path — a vector already embedded with this
   * collection's model; without it the collection embeds for itself.
   */
  async query(text: string, k?: number, precomputedVector?: number[]): Promise<RetrievedChunk[]> {
    if (text.trim() === '') return [];
    const { matrix, rowIds, dims } = this.getQueryMatrix();
    if (rowIds.length === 0) return [];
    const vector = precomputedVector ?? (await this.embedQuery(text));
    if (vector === null) return [];
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
        // Only the pointer travels with a query result; the pane fetches
        // pixels separately, and only for figures it will actually use.
        ...(row.figureId === null || row.figureId === undefined
          ? {}
          : {
              figure: {
                id: row.figureId,
                caption: row.figureCaption ?? row.text,
                described: row.figureDescribed === 1,
              },
            }),
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
      const queue: string[] = [folder];
      while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined) break;
        let entries: Dirent[];
        try {
          entries = await readdir(current, { withFileTypes: true });
        } catch (error) {
          const target = current === folder ? folder : toPosix(relative(folder, current));
          const detail =
            error instanceof Error && 'code' in error && typeof error.code === 'string'
              ? `could not read folder (${error.code})`
              : 'could not read folder';
          this.skip(target, detail);
          continue;
        }
        for (const entry of entries) {
          const absolute = join(current, entry.name);
          if (entry.isDirectory()) {
            queue.push(absolute);
            continue;
          }
          if (!entry.isFile() || !isSupported(entry.name)) continue;
          const source = toPosix(relative(folder, absolute));
          if (seen.has(source)) continue; // overlapping folders: first wins
          seen.add(source);
          out.push({ absolute, source });
        }
      }
    }
    return out.sort((a, b) => a.source.localeCompare(b.source));
  }
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}
