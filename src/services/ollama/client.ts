/**
 * OllamaClient implementation (ARCHITECTURE.md §7.2, ADR-004) — the only
 * consumer-facing entry to the Ollama API. Unary endpoints live here;
 * streaming mechanics live in stream.ts; validation in schemas.ts. Every
 * failure leaves as a typed `OllamaError`/`StreamError`.
 */
import { OllamaError } from '../../types/errors';
import { joinUrl } from '../../utils/url';
import type {
  ChatRequest,
  GenerateRequest,
  HttpTransport,
  OllamaClient,
  OllamaModel,
  OllamaModelDetails,
  StreamEvent,
} from './client.types';
import { classifyFetchFailure } from './diagnostics';
import { parseEmbeddings, parseShow, parseTags, parseVersion } from './schemas';
import { parseChatLine, parseGenerateLine } from './schemas';
import { runStream, throwForStatus } from './stream';
import { composeAbort, defaultTransport } from './transport';

export interface OllamaClientConfig {
  /** API root, e.g. `http://127.0.0.1:11434` or the Mac proxy `https://localhost:11435`. */
  baseUrl: string;
  /** Injectable HTTP seam; defaults to global fetch. */
  transport?: HttpTransport;
  /**
   * Time allowed until a generation request's response headers arrive.
   * Generous by default: a cold model load legitimately takes a while.
   * There is deliberately no inter-token timeout — long generations are fine,
   * and the user always has Stop (ADR-011).
   */
  timeoutMs?: number;
}

/**
 * Idle timeout, NOT a cap on total generation time (ADR-023). It restarts on
 * every chunk, so a model that legitimately generates for many minutes is
 * fine; only genuine silence trips it. Generous because time-to-first-token
 * includes loading a large model from disk and processing a long prompt.
 */
const DEFAULT_STREAM_TIMEOUT_MS = 300_000;
/** Unary endpoints (version/tags/show) answer fast or not at all. */
const UNARY_TIMEOUT_MS = 10_000;

/**
 * Embedding gets its own, much longer budget.
 *
 * `UNARY_TIMEOUT_MS` is sized for `/api/version`, `/api/tags`, and `/api/show`
 * — metadata lookups that return in milliseconds, where ten seconds already
 * means something is wrong. Embedding is compute-bound and its first call also
 * pays for loading the model into memory, which on a laptop with an 8B
 * embedding model can exceed ten seconds on its own. Sharing the metadata
 * timeout meant literature ranking silently timed out and fell back to word
 * overlap on every cold start.
 */
const EMBED_TIMEOUT_MS = 120_000;

/**
 * Inputs per embedding request. A whole result set in one call is a single
 * request large enough to be slow and opaque; chunking bounds each one and
 * lets a partial failure be attributed. Sized so an ordinary search is still
 * one round trip.
 */
const EMBED_BATCH_SIZE = 32;

export function createOllamaClient(config: OllamaClientConfig): OllamaClient {
  const transport = config.transport ?? defaultTransport;
  const timeoutMs = config.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
  const endpoint = (path: string): string => joinUrl(config.baseUrl, path);

  /** GET/POST helper for unary endpoints with the full error mapping. */
  async function requestJson(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
    model: string,
    signal?: AbortSignal,
    timeoutOverrideMs?: number,
    baseUrlOverride?: string,
  ): Promise<unknown> {
    const targetBaseUrl = baseUrlOverride ?? config.baseUrl;
    const isCallerAborted = (): boolean => signal?.aborted === true;
    const budgetMs = timeoutOverrideMs ?? UNARY_TIMEOUT_MS;
    const abort = composeAbort(signal, budgetMs);
    let response: Response;
    try {
      response = await transport(joinUrl(targetBaseUrl, path), {
        method: init.method,
        headers: init.body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: init.body === undefined ? null : JSON.stringify(init.body),
        signal: abort.signal,
      });
    } catch (cause) {
      abort.cleanup();
      if (isCallerAborted()) throw cause; // caller cancelled — pass through untyped
      if (abort.didTimeout()) {
        throw new OllamaError('timeout', `Ollama did not respond within ${String(budgetMs)} ms.`);
      }
      const kind = await classifyFetchFailure(targetBaseUrl, transport, signal);
      if (isCallerAborted()) throw cause; // cancelled while classifying the failure
      throw kind === 'offline'
        ? new OllamaError(
            'offline',
            'Ollama is not reachable. Is it running? Try `ollama serve`.',
            {
              cause,
            },
          )
        : new OllamaError(
            'cors-or-mixed-content',
            'Ollama is running but the browser blocked the call (CORS or mixed content). Run the connection check for a walkthrough.',
            { cause },
          );
    } finally {
      abort.cleanup();
    }

    if (!response.ok) await throwForStatus(response, model);
    try {
      return (await response.json()) as unknown;
    } catch (cause) {
      throw new OllamaError('invalid-response', 'Ollama returned a non-JSON response.', { cause });
    }
  }

  /** Zod failures on unary bodies become `invalid-response`, never raw ZodErrors. */
  function validated<T>(parse: () => T): T {
    try {
      return parse();
    } catch (cause) {
      throw new OllamaError(
        'invalid-response',
        'Ollama answered with an unexpected response shape.',
        { cause },
      );
    }
  }

  return {
    async health(signal?: AbortSignal, baseUrlOverride?: string): Promise<{ version: string }> {
      const json = await requestJson(
        '/api/version',
        { method: 'GET' },
        '',
        signal,
        undefined,
        baseUrlOverride,
      );
      return validated(() => parseVersion(json));
    },

    async listModels(signal?: AbortSignal): Promise<OllamaModel[]> {
      const json = await requestJson('/api/tags', { method: 'GET' }, '', signal);
      return validated(() => parseTags(json));
    },

    async showModel(name: string, signal?: AbortSignal): Promise<OllamaModelDetails> {
      // Both keys on purpose: current Ollama reads `model`, older builds read
      // `name`; each ignores the other. Cheapest possible compatibility.
      const body = { model: name, name };
      const json = await requestJson('/api/show', { method: 'POST', body }, name, signal);
      return validated(() => parseShow(json));
    },

    async embed(
      model: string,
      input: readonly string[],
      signal?: AbortSignal,
    ): Promise<number[][]> {
      if (input.length === 0) return [];

      const vectors: number[][] = [];
      for (let start = 0; start < input.length; start += EMBED_BATCH_SIZE) {
        const batch = input.slice(start, start + EMBED_BATCH_SIZE);
        const json = await requestJson(
          '/api/embed',
          { method: 'POST', body: { model, input: batch } },
          model,
          signal,
          EMBED_TIMEOUT_MS,
        );
        const batchVectors = validated(() => parseEmbeddings(json));
        if (batchVectors.length !== batch.length) {
          throw new OllamaError(
            'invalid-response',
            'Ollama returned a different number of embeddings than inputs.',
          );
        }
        vectors.push(...batchVectors);
      }
      return vectors;
    },

    chat(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
      return runStream({
        url: endpoint('/api/chat'),
        baseUrl: config.baseUrl,
        body: request,
        transport,
        signal,
        timeoutMs,
        parseChunk: parseChatLine,
      });
    },

    generate(request: GenerateRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
      return runStream({
        url: endpoint('/api/generate'),
        baseUrl: config.baseUrl,
        body: request,
        transport,
        signal,
        timeoutMs,
        parseChunk: parseGenerateLine,
      });
    },
  };
}
