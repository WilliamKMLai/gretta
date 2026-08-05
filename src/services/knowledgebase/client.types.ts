/**
 * Knowledge-base companion boundary contract (ARCHITECTURE.md §7, §16;
 * DECISIONS.md ADR-020, multi-collection model). The webview never touches the
 * filesystem — it talks to the local companion (`scripts/kb/server.mts`) over
 * HTTP, exactly as it talks to Ollama. This service is therefore the ONLY place,
 * besides `services/ollama`, permitted to use `fetch` (rule zero).
 *
 * Design contract only in this session; the implementation (`client.ts`,
 * `schemas.ts`, `index.ts`) lands with the approved ADR-020. Services stay
 * independent (ARCHITECTURE.md §5.2 note 2), so this file declares its own
 * transport seam rather than importing Ollama's.
 */
import type {
  CollectionConfig,
  CollectionStatus,
  KnowledgeBaseHealth,
  PickFolderResult,
  RetrievedChunk,
} from '../../types/knowledgebase';

/** Injectable HTTP seam — the sole `fetch` call site, swappable in tests. */
export type HttpTransport = (url: string, init: RequestInit) => Promise<Response>;

/** Isolated client for the local knowledge-base companion. */
export interface KnowledgeBaseClient {
  /** `GET /health` — cheap reachability probe (companion running?). */
  health(signal?: AbortSignal): Promise<KnowledgeBaseHealth>;

  /** `GET /collections` — every knowledge base with its status + capacity. */
  listCollections(signal?: AbortSignal): Promise<CollectionStatus[]>;

  /** `POST /collections` — create or update a collection; starts indexing. */
  upsertCollection(config: CollectionConfig, signal?: AbortSignal): Promise<CollectionStatus>;

  /** `DELETE /collections/:id` — remove a collection and its stored vectors. */
  deleteCollection(id: string, signal?: AbortSignal): Promise<void>;

  /**
   * `POST /collections/:id/reindex` — re-scan now. `full` clears stored
   * vectors first; the default incremental pass only touches changed files.
   */
  reindexCollection(id: string, full: boolean, signal?: AbortSignal): Promise<CollectionStatus>;

  /**
   * `POST /pick-folder` — opens a native folder dialog on the companion's
   * machine and resolves with what the user did (ADR-033).
   *
   * The pane cannot open one itself: Office.js has no directory picker and
   * `showDirectoryPicker()` is absent under WKWebView. Render the button only
   * when `health().pickFolder` is true; a cancelled dialog is an outcome, not
   * an error, and must leave the path input untouched.
   */
  pickFolder(signal?: AbortSignal): Promise<PickFolderResult>;

  /**
   * `POST /query` — top-k relevant chunks across the given collections. Returns
   * an empty array when the selection is empty, the collections are empty, or
   * the companion is unreachable; a failed retrieval must never break generation
   * (ADR-020), so callers treat "no companion" as "no extra context".
   */
  query(
    query: string,
    collectionIds: string[],
    k: number | undefined,
    signal?: AbortSignal,
  ): Promise<RetrievedChunk[]>;
}

/** Constructor config, mirroring `createOllamaClient` (base URL from settings). */
export interface KnowledgeBaseClientConfig {
  /** Companion base URL, e.g. `https://localhost:11436`. */
  baseUrl: string;
  transport?: HttpTransport;
  timeoutMs?: number;
}
