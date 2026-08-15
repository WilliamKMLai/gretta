/**
 * Knowledge-base (RAG) domain + companion wire contract (ARCHITECTURE.md §6,
 * §16; DECISIONS.md ADR-020, revised for the multi-collection model).
 *
 * A knowledge base is a named *collection* backed by one or more folders with
 * its own embedding model. A document binds to a subset of collections; the
 * binding is persisted in the .docx via `Office.context.document.settings`.
 *
 * These shapes are shared across three realms and therefore live in the
 * dependency-free `types/` layer:
 *   - the webview KB service (`services/knowledgebase`) validates companion
 *     responses against them (Zod, mirroring `services/ollama/schemas.ts`);
 *   - the `ai` context-provider pipeline surfaces `RetrievedChunk[]` as
 *     provenance in `ResponseView`;
 *   - the Node companion (`scripts/kb/*`) imports them `import type` (erased at
 *     runtime), so one definition governs both sides of the HTTP boundary.
 *
 * This file is intentionally type-only: no runtime value is exported, so the
 * companion never value-imports across the src/scripts realm boundary (ADR-020).
 * The capacity ceiling is a companion-owned constant; the companion reports
 * `maxChunks`/`capacityPct` as fields the pane reads.
 */

/** Where in a source document a chunk came from — drives the citation label. */
export interface ChunkLocator {
  /** 1-based page number for paginated sources (PDF); null otherwise. */
  page: number | null;
  /** 1-based paragraph index within the source; null when unknown. */
  paragraph: number | null;
}

/** A figure attached to a retrieved chunk (ADR-036). */
export interface RetrievedFigure {
  /** Stable id; fetch the pixels with `getFigure`. */
  id: string;
  /** The caption, as printed in the paper. */
  caption: string;
  /** True once the vision model has described it — retrieval is better then. */
  described: boolean;
}

/** One retrieved chunk with the provenance needed to cite it. */
export interface RetrievedChunk {
  /** Id of the collection this chunk was retrieved from. */
  collectionId: string;
  /** Folder-relative path of the source file (never an absolute host path). */
  source: string;
  /** Position of the chunk within its source. */
  locator: ChunkLocator;
  /** The chunk text injected into the prompt / shown in the sources list. */
  text: string;
  /** Cosine similarity to the query, 0..1. */
  score: number;
  /**
   * Present when this chunk is a figure's caption rather than prose.
   *
   * The pane fetches the pixels separately and only when it will use them, so
   * a query response never carries image bytes for figures nobody looks at.
   */
  figure?: RetrievedFigure | undefined;
}

/** A figure's pixels and metadata (`GET /figures/:collectionId/:figureId`). */
export interface FigureImage {
  id: string;
  source: string;
  page: number;
  caption: string;
  /** The vision model's description, once it has been made. */
  description: string | null;
  mediaType: string;
  /** Base64 PNG, no data-URI prefix — the shape Ollama's `images` field wants. */
  dataBase64: string;
  width: number;
  height: number;
}

/** Lifecycle of a collection's index, surfaced in the KB panel + banner. */
export type IndexPhase =
  | 'disabled' // no folders configured / feature off
  | 'idle' // configured, nothing to do
  | 'scanning' // enumerating the folders
  | 'indexing' // parsing + embedding files
  | 'ready' // fully indexed and queryable
  | 'ollama-unreachable' // embeddings blocked: Ollama down (non-fatal)
  | 'error'; // an indexing failure the user should see

/**
 * A single line of a collection's NDJSON progress stream (see progress.mts).
 * The collection is identified by the stream endpoint, so events stay lean.
 */
export type IndexProgressEvent =
  | { type: 'phase'; phase: IndexPhase }
  | { type: 'scan'; totalFiles: number }
  | { type: 'file'; path: string; filesDone: number; totalFiles: number }
  | { type: 'skip'; path: string; reason: string }
  | { type: 'error'; path: string | null; message: string }
  | { type: 'done'; chunkCount: number; fileCount: number };

/** A collection's static configuration — what the user sets (`POST /collections`). */
export interface CollectionConfig {
  /** Stable id (slug/uuid); also the key retrieval scopes and bindings use. */
  id: string;
  /** Human label shown in the panel and bindings. */
  name: string;
  /** One or more absolute source folders (never leave the host). */
  folders: string[];
  /** Per-collection embedding model; changing it forces a full re-index. */
  embeddingModel: string;
  /**
   * Detect figures in PDFs and make them retrievable (ADR-036).
   *
   * Per-collection rather than global because, like the embedding model, it
   * changes what is *in* the collection. Off by default. Turning it on costs
   * almost nothing at index time — only captions are recorded — and figures are
   * rendered and described the first time something actually asks for one.
   */
  indexFigures: boolean;
}

/** A collection's live status = config + index state + capacity. */
export interface CollectionStatus {
  id: string;
  name: string;
  folders: string[];
  embeddingModel: string;
  phase: IndexPhase;
  /** Files successfully indexed. */
  fileCount: number;
  /** Chunks currently queryable. */
  chunkCount: number;
  /** Companion-owned ceiling used for the capacity readout (ADR-020: 30 000). */
  maxChunks: number;
  /** `chunkCount / maxChunks` as a 0..100 percentage the UI surfaces. */
  capacityPct: number;
  /**
   * `chunkCount > maxChunks`. Advisory, not enforced — indexing is never
   * truncated to stay under the ceiling (ADR-020), so the UI surfaces this
   * rather than the companion silently degrading or dropping sources.
   */
  overCapacity: boolean;
  /** Whether figure detection is on for this collection. */
  indexFigures: boolean;
  /** Figures found, and how many have been described so far. */
  figureCount: number;
  describedFigureCount: number;
  /** Files skipped (unsupported format / parse failure) with reasons. */
  skipped: { path: string; reason: string }[];
  /** ISO timestamp of the last completed index, or null. */
  lastIndexedAt: string | null;
  /** Human-readable detail for `error` / `ollama-unreachable` phases. */
  message: string | null;
}

/** Reported by `GET /health` — the reachability probe (mirrors Ollama's). */
export interface KnowledgeBaseHealth {
  name: 'gretta-kb';
  version: string;
  ok: boolean;
  /**
   * Where the companion keeps its index, reported so the pane can say so.
   *
   * It defaults to `~/.gretta`, outside the repository — deleting and
   * reinstalling the project leaves every collection intact, which is
   * surprising enough that it should be stated rather than discovered.
   * Optional because an older companion will not send it.
   */
  dataDir?: string | undefined;
  /**
   * Whether this companion can open a native folder dialog (ADR-033).
   *
   * Advertised rather than discovered by calling `/pick-folder` and seeing what
   * happens: the pane has to decide whether to render the button *before*
   * anyone clicks it, and a button that opens nothing is worse than no button.
   * Optional, and absent reads as false — an older companion has no dialog.
   */
  pickFolder?: boolean | undefined;
  /**
   * Whether this companion can render and describe figures (ADR-036).
   *
   * Advertised like `pickFolder`, and for the same reason: the pane decides
   * whether to offer the switch before anyone touches it. Absent reads as
   * false, so an older companion simply never offers figures.
   */
  describeFigures?: boolean | undefined;
}

/**
 * Outcome of `POST /pick-folder` (ADR-033).
 *
 * `cancelled` is deliberately not an error: dismissing a dialog is a normal
 * thing to do, and it must leave the path input exactly as it was with no
 * banner. `unsupported` covers every platform without a native dialog (Linux,
 * WSL) where the text input remains the only way in; `busy` means one dialog is
 * already open, which is refused rather than served because two native modal
 * windows on one desktop session is a state with no good exit.
 */
export type PickFolderResult =
  | { ok: true; path: string }
  | {
      ok: false;
      reason: 'cancelled' | 'unsupported' | 'busy' | 'failed';
      message?: string | undefined;
    };

/** Global query-time defaults on the companion (not per collection). */
export interface QueryDefaults {
  /** Chunks retrieved per query. */
  topK: number;
  /** Minimum cosine score for an injected chunk, 0..1. */
  minScore: number;
}
