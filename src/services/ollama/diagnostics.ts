/**
 * Connection diagnostics (ARCHITECTURE.md §12.3) — evolves the Phase 2 spike
 * probe into the typed discriminator the whole app uses. Browsers report
 * offline, CORS-blocked, and mixed-content-blocked identically (an opaque
 * `TypeError`), so the heuristic is:
 *
 *  1. `GET /api/version` in normal CORS mode — success means everything works.
 *  2. On TypeError, ping the base URL with `mode: 'no-cors'`: an opaque
 *     response proves *something* is listening (→ policy-blocked); a
 *     rejection means nothing is (→ offline).
 *  3. Policy-blocked on Word-for-Mac with an http:// URL is WebKit
 *     mixed-content (ADR-008, user-confirmed on real hardware); elsewhere
 *     it's CORS (`OLLAMA_ORIGINS`).
 *
 * Caveat kept from the spike: WebKit can reject even the opaque ping under
 * mixed content, so Mac+http may diagnose as `offline` — UI copy for that
 * combination mentions the proxy either way.
 */
import type { HostPlatform } from '../../types/domain';
import { joinUrl } from '../../utils/url';
import type { HttpTransport } from './client.types';
import { parseVersion } from './schemas';
import { composeAbort, defaultTransport } from './transport';

const VERSION_TIMEOUT_MS = 5000;
const PING_TIMEOUT_MS = 3000;

export type ConnectionDiagnosis =
  | { status: 'ok'; version: string; latencyMs: number }
  | { status: 'offline'; detail: string }
  | { status: 'blocked'; reason: 'mixed-content' | 'cors'; detail: string }
  | { status: 'http-error'; httpStatus: number }
  | { status: 'invalid-response'; detail: string };

export interface DiagnoseArgs {
  baseUrl: string;
  platform: HostPlatform;
  transport?: HttpTransport;
  signal?: AbortSignal | undefined;
}

function describeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value === 'string' ? value : 'Unknown error';
}

/** True when *anything* answers a no-cors ping — reachable but maybe blocked. */
async function answersOpaquePing(
  baseUrl: string,
  transport: HttpTransport,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted === true) return false;
  const abort = composeAbort(signal, PING_TIMEOUT_MS);
  try {
    await transport(baseUrl, {
      method: 'GET',
      mode: 'no-cors',
      signal: abort.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    abort.cleanup();
  }
}

/**
 * Shared with the client's error mapping: after a fetch TypeError, decides
 * between `offline` and `cors-or-mixed-content` (the client doesn't know the
 * platform, so the finer mixed-content-vs-CORS split stays UI-side).
 */
export async function classifyFetchFailure(
  baseUrl: string,
  transport: HttpTransport,
  signal?: AbortSignal,
): Promise<'offline' | 'cors-or-mixed-content'> {
  return (await answersOpaquePing(baseUrl, transport, signal))
    ? 'cors-or-mixed-content'
    : 'offline';
}

/** Classifies connectivity to an Ollama base URL. Never throws. */
export async function diagnoseConnection(args: DiagnoseArgs): Promise<ConnectionDiagnosis> {
  const transport = args.transport ?? defaultTransport;
  const startedAt = performance.now();

  let response: Response;
  try {
    const abort = composeAbort(args.signal, VERSION_TIMEOUT_MS);
    try {
      response = await transport(joinUrl(args.baseUrl, '/api/version'), {
        method: 'GET',
        signal: abort.signal,
      });
    } finally {
      abort.cleanup();
    }
  } catch (error) {
    const detail = describeUnknown(error);
    if (!(await answersOpaquePing(args.baseUrl, transport, args.signal))) {
      return { status: 'offline', detail };
    }
    const mixedContent = args.platform === 'Mac' && args.baseUrl.startsWith('http:');
    return { status: 'blocked', reason: mixedContent ? 'mixed-content' : 'cors', detail };
  }

  if (!response.ok) return { status: 'http-error', httpStatus: response.status };

  try {
    const { version } = parseVersion(await response.json());
    return { status: 'ok', version, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return { status: 'invalid-response', detail: describeUnknown(error) };
  }
}
