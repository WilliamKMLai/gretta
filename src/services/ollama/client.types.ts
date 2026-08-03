/**
 * Ollama boundary contract (ARCHITECTURE.md §7.2, ADR-004).
 *
 * `services/ollama` is the ONLY place `fetch` may be used (rule zero, enforced
 * by lint). Phase 4 supplies the implementation: NDJSON incremental parsing,
 * Zod validation of every payload, and typed error mapping.
 */
import type { GenerationStats, Role } from '../../types/domain';

/**
 * The wire seam (ADR-008): the client performs all HTTP through an injected
 * transport, so alternative paths (e.g. the macOS HTTPS loopback proxy, test
 * fakes built on `ReadableStream`) are drop-in replacements for global fetch.
 */
export type HttpTransport = (url: string, init: RequestInit) => Promise<Response>;

/** One locally installed model, normalized from `GET /api/tags`. */
export interface OllamaModel {
  /** Full model tag, e.g. `llama3.1:8b`. */
  name: string;
  /** On-disk size in bytes. */
  size: number;
  /** ISO 8601 last-modified timestamp. */
  modifiedAt: string;
  /** Human-readable parameter count, e.g. `8.0B`, when reported. */
  parameterSize: string | null;
  /** Quantization level, e.g. `Q4_K_M`, when reported. */
  quantization: string | null;
}

/** Detail view of a single model, normalized from `POST /api/show`. */
export interface OllamaModelDetails {
  family: string | null;
  parameterSize: string | null;
  quantizationLevel: string | null;
  /** Maximum context window the model supports, when reported. */
  contextLength: number | null;
  /** Capability flags reported by Ollama (e.g. `completion`, `tools`). */
  capabilities: string[];
}

/** Sampling options in Ollama's own field names (`options` object). */
export interface OllamaOptions {
  temperature: number;
  top_p: number;
  top_k: number;
  /** Omitted from the request when undefined (non-deterministic sampling). */
  seed?: number;
  num_ctx: number;
}

/** Request body for `POST /api/chat`. */
export interface ChatRequest {
  model: string;
  messages: { role: Role; content: string }[];
  options: OllamaOptions;
  stream: boolean;
}

/** Request body for `POST /api/generate`. */
export interface GenerateRequest {
  model: string;
  prompt: string;
  system?: string;
  options: OllamaOptions;
  stream: boolean;
}

/**
 * Events yielded by streaming calls. Non-streaming requests use the identical
 * contract: exactly one `token` event carrying the full text, then `done`.
 */
export type StreamEvent =
  { type: 'token'; content: string } | { type: 'done'; stats: GenerationStats };

/**
 * Isolated Ollama API client.
 *
 * Cancellation contract: abort the passed `AbortSignal`. Closing the HTTP
 * connection makes the Ollama daemon stop generating server-side; user
 * cancellation is a normal terminal state, not an error (ADR-011).
 * Failure contract: implementations throw typed `OllamaError` / `StreamError`
 * (never raw `TypeError`s or unvalidated payloads).
 */
export interface OllamaClient {
  /** `GET /api/version` — cheap reachability + CORS probe. */
  /**
   * `GET /api/version`. `baseUrlOverride` exists so a caller can probe a second
   * address without rebuilding a client — used to try the Mac HTTPS proxy when
   * the configured address fails, rather than making the user find that in the
   * documentation.
   */
  health(signal?: AbortSignal, baseUrlOverride?: string): Promise<{ version: string }>;

  /** `GET /api/tags` — locally installed models. */
  listModels(signal?: AbortSignal): Promise<OllamaModel[]>;

  /** `POST /api/show` — details for one model. */
  showModel(name: string, signal?: AbortSignal): Promise<OllamaModelDetails>;

  /**
   * `POST /api/embed` — vectors for one or more inputs (ADR-030).
   *
   * Batched because the literature re-ranker always has a passage plus N
   * abstracts and wants them in one round trip. Returns raw vectors and nothing
   * else; cosine lives in `services/literature/rank.ts`.
   */
  embed(model: string, input: readonly string[], signal?: AbortSignal): Promise<number[][]>;

  /** `POST /api/chat` — conversation completion as an event stream. */
  chat(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;

  /** `POST /api/generate` — single-prompt completion as an event stream. */
  generate(request: GenerateRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}
