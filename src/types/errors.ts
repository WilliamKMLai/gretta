/**
 * Typed error taxonomy (ARCHITECTURE.md §12.1).
 *
 * Every service boundary throws exactly one of these classes — never a raw
 * `OfficeExtension.Error`, `TypeError`, or unvalidated payload. `kind` is the
 * discriminant the UI maps to friendly copy (`describeError`, Phase 6);
 * `code` preserves the underlying platform code for diagnostics; `cause`
 * carries the original value (own property — lib is ES2020, which predates
 * `Error.cause`). User cancellation is a state, not an error (ADR-011).
 */

export type OfficeErrorKind =
  'host-unavailable' | 'no-document' | 'no-selection' | 'api-unsupported' | 'office-failed';

export type OllamaErrorKind =
  'offline' | 'cors-or-mixed-content' | 'timeout' | 'http' | 'model-not-found' | 'invalid-response';

export type StreamErrorKind = 'interrupted' | 'parse';

export type StorageErrorKind = 'quota-exceeded' | 'corrupt';

/** Knowledge-base companion failures (thrown only by services/knowledgebase). */
export type KbErrorKind = 'offline' | 'http' | 'invalid-response';

/**
 * Literature-source failures (thrown only by services/literature).
 * `source-disabled` and `query-rejected` are not transport failures: they are
 * ADR-028's policy gates surfacing as errors, so that a disabled source or an
 * over-long derived query fails loudly at the boundary rather than being
 * silently skipped somewhere upstream.
 */
export type LiteratureErrorKind =
  'offline' | 'http' | 'rate-limited' | 'invalid-response' | 'source-disabled' | 'query-rejected';

interface ErrorOptions {
  code?: string;
  cause?: unknown;
}

/** Word/Office boundary failures (thrown only by services/office). */
export class OfficeError extends Error {
  readonly kind: OfficeErrorKind;
  readonly code?: string;
  override readonly cause?: unknown;

  constructor(kind: OfficeErrorKind, message: string, options?: ErrorOptions) {
    super(message);
    this.name = 'OfficeError';
    this.kind = kind;
    if (options?.code !== undefined) this.code = options.code;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** Ollama HTTP/API failures (thrown only by services/ollama). */
export class OllamaError extends Error {
  readonly kind: OllamaErrorKind;
  readonly code?: string;
  override readonly cause?: unknown;

  constructor(kind: OllamaErrorKind, message: string, options?: ErrorOptions) {
    super(message);
    this.name = 'OllamaError';
    this.kind = kind;
    if (options?.code !== undefined) this.code = options.code;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** Mid-stream failures; carries whatever text arrived before the break. */
export class StreamError extends Error {
  readonly kind: StreamErrorKind;
  readonly partialText: string;
  override readonly cause?: unknown;

  constructor(kind: StreamErrorKind, message: string, partialText: string, cause?: unknown) {
    super(message);
    this.name = 'StreamError';
    this.kind = kind;
    this.partialText = partialText;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Persistence failures (thrown only by services/storage). */
export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  override readonly cause?: unknown;

  constructor(kind: StorageErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'StorageError';
    this.kind = kind;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Local knowledge-base companion failures. `offline` is the common case (the
 * companion simply isn't running) and is deliberately non-fatal everywhere:
 * retrieval is best-effort context, so generation continues without it
 * (ADR-020).
 */
export class KbError extends Error {
  readonly kind: KbErrorKind;
  readonly code?: string;
  override readonly cause?: unknown;

  constructor(kind: KbErrorKind, message: string, options?: ErrorOptions) {
    super(message);
    this.name = 'KbError';
    this.kind = kind;
    if (options?.code !== undefined) this.code = options.code;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Third-party scholarly-source failures. Unlike KbError, an `offline` here is
 * NOT routinely benign: the user asked for a search and did not get one, so it
 * is surfaced rather than swallowed. Nothing in this class can reach the
 * generation path, because no literature code runs there (ADR-028).
 */
export class LiteratureError extends Error {
  readonly kind: LiteratureErrorKind;
  /** Which source failed, so the pane can name it instead of failing generically. */
  readonly source: string;
  readonly code?: string;
  override readonly cause?: unknown;

  constructor(kind: LiteratureErrorKind, source: string, message: string, options?: ErrorOptions) {
    super(message);
    this.name = 'LiteratureError';
    this.kind = kind;
    this.source = source;
    if (options?.code !== undefined) this.code = options.code;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export type AppError =
  OfficeError | OllamaError | StreamError | StorageError | KbError | LiteratureError;

export function isAppError(value: unknown): value is AppError {
  return (
    value instanceof OfficeError ||
    value instanceof OllamaError ||
    value instanceof StreamError ||
    value instanceof StorageError ||
    value instanceof KbError ||
    value instanceof LiteratureError
  );
}

/**
 * Boundary normalizer: passes existing AppErrors through untouched and hands
 * anything else to the boundary's own wrapper.
 */
export function toAppError(value: unknown, wrap: (cause: unknown) => AppError): AppError {
  return isAppError(value) ? value : wrap(value);
}

/** Actionable copy for a failed Ollama call, shared by the banner and Settings. */
export interface OllamaGuidance {
  title: string;
  body: string;
}

/**
 * Maps a failed Ollama call to the concrete next step (ARCHITECTURE.md §12.1;
 * the `describeError` mapping this file's header refers to). Kept here rather
 * than in either feature so the connection banner and Settings' "Test
 * connection" can never give contradictory advice. Takes `isMac` instead of
 * the Office `HostInfo` so the types layer stays import-free.
 */
export function describeOllamaError(
  error: unknown,
  context: { url: string; isMac: boolean },
): OllamaGuidance {
  const kind = error instanceof OllamaError ? error.kind : null;
  switch (kind) {
    case 'offline':
      return {
        title: `Can't reach Ollama at ${context.url}`,
        body: 'Start it with `ollama serve` — the pane reconnects automatically.',
      };
    case 'cors-or-mixed-content':
      if (context.isMac && context.url.startsWith('http://')) {
        return {
          title: 'Word on Mac blocks plain-HTTP requests',
          body: 'Run `pnpm proxy`, then set the server URL to https://localhost:11435 in Settings.',
        };
      }
      return {
        title: 'The request was blocked (CORS)',
        body: 'Allow this origin: set OLLAMA_ORIGINS for the Ollama daemon and restart it.',
      };
    case 'timeout':
      return {
        title: 'Ollama took too long to answer',
        body: 'The daemon may be busy loading a model — retry in a moment.',
      };
    case 'model-not-found':
      return {
        title: 'That model is not installed',
        body: 'Pull it first (`ollama pull <model>`), or pick another in Settings.',
      };
    default:
      return {
        title: 'Ollama returned an unexpected response',
        body: error instanceof Error ? error.message : 'Check the server URL in Settings.',
      };
  }
}
