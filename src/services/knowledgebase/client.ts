/**
 * KnowledgeBaseClient implementation (ARCHITECTURE.md §7; DECISIONS.md
 * ADR-020) — the only consumer-facing entry to the local companion, and one of
 * exactly two places in the app permitted to call `fetch` (rule zero).
 *
 * Every failure leaves as a typed `KbError`. Callers are expected to treat
 * `offline` as "no extra context" rather than an error state: the companion is
 * optional, and generation must work without it.
 */
import { KbError } from '../../types/errors';
import type {
  CollectionConfig,
  CollectionStatus,
  KnowledgeBaseHealth,
  PickFolderResult,
  RetrievedChunk,
} from '../../types/knowledgebase';
import { joinUrl } from '../../utils/url';
import type { HttpTransport, KnowledgeBaseClient, KnowledgeBaseClientConfig } from './client.types';
import {
  parseCollection,
  parseCollections,
  parseHealth,
  parsePickFolder,
  parseQuery,
  tryParseErrorBody,
} from './schemas';

/** The companion is local: it answers fast or it is not running. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The one route that is allowed to be slow, because it is waiting on a person
 * browsing a native dialog rather than on the companion (ADR-033). Slightly
 * over the companion's own two-minute cap on the dialog, so the timeout that
 * fires is the one that can clean up the child process.
 */
const PICK_FOLDER_TIMEOUT_MS = 130_000;

const defaultTransport: HttpTransport = (url, init) => fetch(url, init);

export function createKnowledgeBaseClient(config: KnowledgeBaseClientConfig): KnowledgeBaseClient {
  const transport = config.transport ?? defaultTransport;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = (path: string): string => joinUrl(config.baseUrl, path);

  async function request(
    path: string,
    init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(onAbort, init.timeoutMs ?? timeoutMs);

    let response: Response;
    try {
      response = await transport(endpoint(path), {
        method: init.method,
        headers: init.body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: init.body === undefined ? null : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (cause) {
      if (signal?.aborted === true) throw cause; // caller cancelled — pass through
      throw new KbError(
        'offline',
        'The knowledge-base companion is not reachable. Start it with `pnpm kb`.',
        { cause },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
      const detail = tryParseErrorBody(await response.text().catch(() => ''));
      throw new KbError(
        'http',
        detail ?? `The companion returned HTTP ${String(response.status)}.`,
        {
          code: String(response.status),
        },
      );
    }
    try {
      return (await response.json()) as unknown;
    } catch (cause) {
      throw new KbError('invalid-response', 'The companion returned a non-JSON response.', {
        cause,
      });
    }
  }

  /** Zod failures become `invalid-response`, never raw ZodErrors. */
  function validated<T>(parse: () => T): T {
    try {
      return parse();
    } catch (cause) {
      throw new KbError('invalid-response', 'The companion answered with an unexpected shape.', {
        cause,
      });
    }
  }

  return {
    async health(signal?: AbortSignal): Promise<KnowledgeBaseHealth> {
      const json = await request('/health', { method: 'GET' }, signal);
      return validated(() => parseHealth(json));
    },

    async listCollections(signal?: AbortSignal): Promise<CollectionStatus[]> {
      const json = await request('/collections', { method: 'GET' }, signal);
      return validated(() => parseCollections(json));
    },

    async upsertCollection(
      collection: CollectionConfig,
      signal?: AbortSignal,
    ): Promise<CollectionStatus> {
      const json = await request('/collections', { method: 'POST', body: collection }, signal);
      return validated(() => parseCollection(json));
    },

    async deleteCollection(id: string, signal?: AbortSignal): Promise<void> {
      await request(`/collections/${encodeURIComponent(id)}`, { method: 'DELETE' }, signal);
    },

    async reindexCollection(
      id: string,
      full: boolean,
      signal?: AbortSignal,
    ): Promise<CollectionStatus> {
      const json = await request(
        `/collections/${encodeURIComponent(id)}/reindex`,
        { method: 'POST', body: { full } },
        signal,
      );
      return validated(() => parseCollection(json));
    },

    async pickFolder(signal?: AbortSignal): Promise<PickFolderResult> {
      /*
       * No body, deliberately: there is no parameter, so there is nothing a
       * caller could inject into the script the companion runs (ADR-033). The
       * default 10s timeout would fire long before a human finishes browsing,
       * so this request opts out of it — the companion enforces its own
       * two-minute bound on the dialog instead.
       */
      const json = await request(
        '/pick-folder',
        { method: 'POST', timeoutMs: PICK_FOLDER_TIMEOUT_MS },
        signal,
      );
      return validated(() => parsePickFolder(json));
    },

    async query(
      query: string,
      collectionIds: string[],
      k: number | undefined,
      signal?: AbortSignal,
    ): Promise<RetrievedChunk[]> {
      if (collectionIds.length === 0 || query.trim() === '') return [];
      const body = k === undefined ? { query, collectionIds } : { query, collectionIds, k };
      const json = await request('/query', { method: 'POST', body }, signal);
      return validated(() => parseQuery(json));
    },
  };
}
