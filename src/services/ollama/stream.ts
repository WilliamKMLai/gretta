/**
 * Streaming request runner shared by chat() and generate() (ARCHITECTURE.md
 * §7.2, §10). One place owns the whole lifecycle:
 *
 *  request → headers (first-byte timeout) → NDJSON lines → events → done
 *
 * Terminal semantics (ADR-011):
 *  - caller abort  → the generator simply ends: no event, no error;
 *  - timeout       → OllamaError('timeout');
 *  - network fail  → OllamaError('offline' | 'cors-or-mixed-content');
 *  - HTTP error    → OllamaError('http' | 'model-not-found');
 *  - server drop / `{"error"}` line → StreamError('interrupted', partialText);
 *  - malformed line → StreamError('parse', partialText).
 *
 * Early consumer exit (a `break` in `for await`) aborts the connection in the
 * `finally`, which stops generation server-side — verified against the proxy
 * in Phase 2.
 */
import { OllamaError, StreamError } from '../../types/errors';
import type { HttpTransport, StreamEvent } from './client.types';
import { classifyFetchFailure } from './diagnostics';
import { NdjsonParser } from './ndjson';
import type { ParsedChunk } from './schemas';
import { tryParseErrorBody } from './schemas';
import { composeAbort } from './transport';
import type { ComposedAbort } from './transport';

export interface StreamRunArgs {
  /** Fully joined endpoint URL, e.g. `http://127.0.0.1:11434/api/chat`. */
  url: string;
  /** Base URL, used only to classify network failures (offline vs blocked). */
  baseUrl: string;
  /** JSON-serializable request body; `stream` decides the response mode. */
  body: { model: string; stream: boolean };
  transport: HttpTransport;
  /** Caller's cancellation signal (required by the OllamaClient contract). */
  signal: AbortSignal;
  /** Time allowed until response headers arrive. */
  timeoutMs: number;
  /** Endpoint-specific line validator (schemas.ts). */
  parseChunk: (json: unknown) => ParsedChunk;
}

/** Maps a failed HTTP response to a typed error. Consumes the body. */
export async function throwForStatus(response: Response, model: string): Promise<never> {
  const text = await response.text().catch(() => '');
  const serverMessage = tryParseErrorBody(text);
  const status = String(response.status);
  if (response.status === 404 || (serverMessage !== null && /not found/i.test(serverMessage))) {
    throw new OllamaError(
      'model-not-found',
      `Model "${model}" isn't installed in Ollama. Pull it first (ollama pull ${model}) or pick another model.`,
      { code: status },
    );
  }
  throw new OllamaError(
    'http',
    `Ollama answered HTTP ${status}${serverMessage === null ? '' : ` — ${serverMessage}`}.`,
    { code: status },
  );
}

/** Distinguishes "nothing listening" from "reachable but policy-blocked". */
async function mapNetworkFailure(
  baseUrl: string,
  transport: HttpTransport,
  cause: unknown,
  signal: AbortSignal,
): Promise<OllamaError> {
  const kind = await classifyFetchFailure(baseUrl, transport, signal);
  return kind === 'offline'
    ? new OllamaError('offline', 'Ollama is not reachable. Is it running? Try `ollama serve`.', {
        cause,
      })
    : new OllamaError(
        'cors-or-mixed-content',
        'Ollama is running but the browser blocked the call (CORS or mixed content). Run the connection check for a walkthrough.',
        { cause },
      );
}

export async function* runStream(args: StreamRunArgs): AsyncGenerator<StreamEvent, void, unknown> {
  const isCallerAborted = (): boolean => args.signal.aborted;
  const abort = composeAbort(args.signal, args.timeoutMs);

  let response: Response;
  try {
    response = await args.transport(args.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args.body),
      signal: abort.signal,
    });
  } catch (cause) {
    abort.cleanup();
    if (isCallerAborted()) return; // clean cancellation
    if (abort.didTimeout()) {
      throw new OllamaError(
        'timeout',
        `Ollama did not respond within ${String(args.timeoutMs)} ms.`,
      );
    }
    const failure = await mapNetworkFailure(args.baseUrl, args.transport, cause, args.signal);
    if (isCallerAborted()) return; // cancelled while classifying the failure
    throw failure;
  }

  try {
    if (!response.ok) await throwForStatus(response, args.body.model);

    // Non-streaming mode: the body is a single JSON chunk with done: true.
    if (!args.body.stream) {
      let text: string;
      try {
        text = await response.text();
      } catch (cause) {
        if (args.signal.aborted) return; // clean cancellation
        throw new OllamaError('invalid-response', 'Failed to read the response from Ollama.', {
          cause,
        });
      }
      if (args.signal.aborted) return; // clean cancellation
      const chunk = parseJsonChunk(text, args.parseChunk, '');
      if (chunk.kind === 'server-error') {
        throw new StreamError('interrupted', chunk.message, '');
      }
      if (chunk.content !== '') yield { type: 'token', content: chunk.content };
      if (chunk.kind === 'final') yield { type: 'done', stats: chunk.stats };
      return;
    }

    if (response.body === null) {
      throw new OllamaError('invalid-response', 'Ollama returned an empty response body.');
    }
    yield* pumpNdjson(response.body, args, abort);
  } finally {
    // Kills the connection on early consumer exit or failure; harmless after
    // normal completion. Server-side generation stops when the socket closes.
    abort.abort();
    abort.cleanup();
  }
}

/** The NDJSON read loop, factored out so the cancellation paths stay readable. */
async function* pumpNdjson(
  body: ReadableStream<Uint8Array>,
  args: StreamRunArgs,
  abort: ComposedAbort,
): AsyncGenerator<StreamEvent, void, unknown> {
  const reader = body.getReader();
  const parser = new NdjsonParser();
  let partial = '';

  // Injected transports don't observe AbortSignal, so cancellation must also
  // resolve a pending read() directly. reader.cancel() does exactly that.
  //
  // This listens on the COMPOSED signal, not the caller's: it fires for a user
  // cancel *and* for the idle timeout. Watching only the caller's signal left
  // the timeout unable to unstick a pending read whenever the transport
  // ignored the signal — the timeout would arm, abort, and nothing would
  // happen (ADR-023).
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (abort.signal.aborted) onAbort();
  else abort.signal.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (cause) {
        if (args.signal.aborted) return; // clean cancellation
        if (abort.didTimeout()) {
          // Silence, not slowness: the model sent nothing for the whole idle
          // window. A long generation resets the clock on every chunk.
          throw new StreamError(
            'interrupted',
            `Ollama stopped sending data for ${String(Math.round(args.timeoutMs / 1000))}s. ` +
              'The model may have stalled or run out of memory.',
            partial,
            cause,
          );
        }
        throw new StreamError(
          'interrupted',
          'The connection to Ollama was interrupted mid-generation.',
          partial,
          cause,
        );
      }
      // Bytes arrived — the connection is alive, so restart the idle clock.
      abort.resetTimer();

      const lines = read.done ? parser.flush() : parser.push(read.value);
      for (const line of lines) {
        const chunk = parseJsonChunk(line, args.parseChunk, partial);
        if (chunk.kind === 'server-error') {
          throw new StreamError('interrupted', `Ollama reported: ${chunk.message}`, partial);
        }
        if (chunk.content !== '') {
          partial += chunk.content;
          yield { type: 'token', content: chunk.content };
        }
        if (chunk.kind === 'final') {
          yield { type: 'done', stats: chunk.stats };
          return;
        }
      }

      if (read.done) {
        if (args.signal.aborted) return; // cancellation surfaced as a closed stream
        // A timeout cancels the reader, which surfaces here as a closed stream
        // rather than a throw — so name the real cause instead of blaming the
        // server for hanging up (ADR-023).
        throw new StreamError(
          'interrupted',
          abort.didTimeout()
            ? `Ollama stopped sending data for ${String(Math.round(args.timeoutMs / 1000))}s. ` +
                'The model may have stalled or run out of memory.'
            : 'Ollama closed the stream before finishing the response.',
          partial,
        );
      }
    }
  } finally {
    abort.signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => undefined);
  }
}

/** JSON.parse + endpoint schema, with both failure modes mapped to StreamError('parse'). */
function parseJsonChunk(
  raw: string,
  parseChunk: (json: unknown) => ParsedChunk,
  partial: string,
): ParsedChunk {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new StreamError('parse', 'Ollama sent a line that is not valid JSON.', partial, cause);
  }
  try {
    return parseChunk(json);
  } catch (cause) {
    throw new StreamError(
      'parse',
      'Ollama sent a response chunk with an unexpected shape.',
      partial,
      cause,
    );
  }
}
