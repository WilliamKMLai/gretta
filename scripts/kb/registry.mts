/**
 * Collection registry + file watching (DECISIONS.md ADR-020).
 *
 * Owns the set of collections the companion manages, restores them from SQLite
 * on boot (so a restart resumes with everything already indexed), and keeps a
 * debounced watcher per collection. Editors write a file several times per
 * save, so watcher events are coalesced before an incremental pass runs.
 */
import { watch, type FSWatcher } from 'node:fs';
import type {
  CollectionConfig,
  CollectionStatus,
  IndexProgressEvent,
  QueryDefaults,
  RetrievedChunk,
} from '../../src/types/knowledgebase';
import { CollectionIndexer } from './index-store.mts';
import type { SqliteStore } from './store.sqlite.mts';

/** Coalescing window for watcher events (editors write repeatedly per save). */
export const WATCH_DEBOUNCE_MS = 750;

interface Entry {
  indexer: CollectionIndexer;
  watchers: FSWatcher[];
  timer: NodeJS.Timeout | null;
}

export class CollectionRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly store: SqliteStore;
  private readonly defaults: QueryDefaults;
  private readonly ollamaUrl: string;
  private readonly watchEnabled: boolean;

  constructor(store: SqliteStore, defaults: QueryDefaults, ollamaUrl: string, watchEnabled = true) {
    this.store = store;
    this.defaults = defaults;
    this.ollamaUrl = ollamaUrl;
    this.watchEnabled = watchEnabled;
    for (const row of store.listCollections()) {
      this.entries.set(row.id, {
        indexer: new CollectionIndexer(
          {
            id: row.id,
            name: row.name,
            folders: row.folders,
            embeddingModel: row.embeddingModel,
          },
          store,
          defaults,
          ollamaUrl,
        ),
        watchers: [],
        timer: null,
      });
    }
  }

  list(): CollectionStatus[] {
    return [...this.entries.values()].map((entry) => entry.indexer.status());
  }

  get(id: string): CollectionIndexer | null {
    return this.entries.get(id)?.indexer ?? null;
  }

  /** Restarts watching + a background index pass for every restored collection. */
  resumeAll(): void {
    for (const [id, entry] of this.entries) {
      this.arm(id);
      void entry.indexer.reindex();
    }
  }

  /** Creates or updates a collection, then indexes it (incrementally). */
  async upsert(config: CollectionConfig): Promise<CollectionStatus> {
    let entry = this.entries.get(config.id);
    if (entry === undefined) {
      entry = {
        indexer: new CollectionIndexer(config, this.store, this.defaults, this.ollamaUrl),
        watchers: [],
        timer: null,
      };
      this.entries.set(config.id, entry);
    }
    await entry.indexer.setConfig(config);
    this.arm(config.id);
    return entry.indexer.status();
  }

  /** Removes a collection, its watchers, and all of its stored vectors. */
  delete(id: string): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined) return false;
    this.disarm(entry);
    this.store.deleteCollection(id);
    this.entries.delete(id);
    return true;
  }

  onProgress(id: string, listener: (event: IndexProgressEvent) => void): (() => void) | null {
    return this.entries.get(id)?.indexer.onProgress(listener) ?? null;
  }

  /** Ranks across several collections at once, best chunks first. */
  async query(collectionIds: string[], text: string, k?: number): Promise<RetrievedChunk[]> {
    const limit = k ?? this.defaults.topK;
    const perCollection = await Promise.all(
      collectionIds.map(async (id) => (await this.get(id)?.query(text, limit)) ?? []),
    );
    return perCollection
      .flat()
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  closeAll(): void {
    for (const entry of this.entries.values()) this.disarm(entry);
  }

  /** (Re)installs debounced watchers for a collection's folders. */
  private arm(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined || !this.watchEnabled) return;
    this.disarm(entry);
    for (const folder of entry.indexer.status().folders) {
      try {
        const watcher = watch(folder, { recursive: true }, () => {
          if (entry.timer !== null) clearTimeout(entry.timer);
          entry.timer = setTimeout(() => {
            entry.timer = null;
            void entry.indexer.reindex();
          }, WATCH_DEBOUNCE_MS);
        });
        watcher.on('error', () => {
          /* a folder that vanishes surfaces on the next index pass */
        });
        entry.watchers.push(watcher);
      } catch {
        // Recursive watching is unsupported on some platforms/filesystems;
        // indexing still works on demand, so this is not an error.
      }
    }
  }

  private disarm(entry: Entry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    for (const watcher of entry.watchers) watcher.close();
    entry.watchers = [];
  }
}
