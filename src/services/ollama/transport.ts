/**
 * HTTP seam for services/ollama (ARCHITECTURE.md §7.2, ADR-008).
 *
 * The default transport is the only place in the codebase that touches global
 * `fetch`. Tests inject transports built on `Response` + `ReadableStream`;
 * the macOS HTTPS proxy needs no special transport — it's just a different
 * base URL.
 */
import type { HttpTransport } from './client.types';

export const defaultTransport: HttpTransport = (url, init) => fetch(url, init);

export interface ComposedAbort {
  /** Pass to the transport: fires on caller abort OR timeout. */
  signal: AbortSignal;
  /** True once the timeout (not the caller) caused the abort. */
  didTimeout: () => boolean;
  /** Abort manually (e.g. to close the connection on early consumer exit). */
  abort: () => void;
  /** Restart the idle clock; call whenever bytes arrive (ADR-023). */
  resetTimer: () => void;
  /** Always call in a finally: clears the timer and unlinks the caller signal. */
  cleanup: () => void;
}

/**
 * One controller fed by two sources: the caller's optional signal and a
 * timeout. Built manually instead of `AbortSignal.any`/`AbortSignal.timeout`
 * composition because we must (a) run on WKWebView versions that predate
 * `AbortSignal.any` (Safari < 17.4) and (b) distinguish *which* source fired —
 * timeout maps to `OllamaError('timeout')`, caller abort is a clean
 * cancellation, never an error (ADR-011).
 */
export function composeAbort(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): ComposedAbort {
  const controller = new AbortController();
  let timedOut = false;
  const armed = Number.isFinite(timeoutMs) && timeoutMs > 0;

  const onCallerAbort = (): void => {
    controller.abort(callerSignal?.reason);
  };
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (): void => {
    if (!armed) return;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  arm();

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    abort: () => {
      controller.abort();
    },
    /**
     * Restarts the clock. The timeout measures SILENCE, not total duration:
     * a large model can legitimately generate for many minutes, and a wall
     * clock on the whole stream kills working generations (ADR-023). Callers
     * reset this every time bytes arrive.
     */
    resetTimer: () => {
      if (timer !== null) clearTimeout(timer);
      arm();
    },
    cleanup: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}
