/**
 * Composition root (ARCHITECTURE.md §7.4, ADR-003 + Phase 5 amendment).
 *
 * One module owns the concrete service instances; hooks, stores, and features
 * consume `getServices()`. No DI framework, no React Context. In the
 * boundaries layer graph this file is its own element (`services-root`) so
 * features may import it without gaining access to the rest of app/.
 *
 * The Ollama client honors §7.2's "base URL is read from settings at call
 * time": each call builds a throwaway client bound to the CURRENT settings
 * URL (client construction is a cheap closure), so URL changes apply without
 * reloads or re-wiring.
 */
import { useSettingsStore } from '../features/settings';
import { createClipboardService } from '../services/clipboard';
import type { ClipboardService } from '../services/clipboard';
import { createOfficeService } from '../services/office';
import type { HostInfo, OfficeService } from '../services/office';
import { createKnowledgeBaseClient } from '../services/knowledgebase';
import type { KnowledgeBaseClient, KnowledgeBaseClientConfig } from '../services/knowledgebase';
import { MAC_PROXY_URL, createOllamaClient } from '../services/ollama';
import type { OllamaClient, OllamaClientConfig } from '../services/ollama';
import { storageService } from '../services/storage';
import type { StorageService } from '../services/storage';

export interface Services {
  office: OfficeService;
  ollama: OllamaClient;
  storage: StorageService;
  clipboard: ClipboardService;
  /** Local knowledge-base companion (ADR-020); optional at runtime. */
  kb: KnowledgeBaseClient;
}

/** jsdom/browser fallback so tests and dev tools need zero setup. */
const BROWSER_HOST: HostInfo = { available: false, host: 'unknown', platform: 'unknown' };

/**
 * OllamaClient façade that resolves the base URL from the settings store on
 * every call. `factory` is injectable for tests.
 */
export function createSettingsBoundOllamaClient(
  factory: (config: OllamaClientConfig) => OllamaClient = createOllamaClient,
): OllamaClient {
  const client = (baseUrl?: string): OllamaClient =>
    factory({ baseUrl: baseUrl ?? useSettingsStore.getState().ollamaUrl });
  return {
    /*
     * Tries the configured address, then the Mac HTTPS proxy once.
     *
     * Word for Mac runs the pane in WKWebView, which refuses to let an HTTPS
     * page call `http://localhost`. GRETTA ships a proxy for exactly this, but
     * the user previously had to notice the failure, find the Mac section of
     * the README, and edit the server URL by hand — a documentation fix for
     * something the app can resolve itself, since both candidate addresses are
     * known.
     *
     * The setting is rewritten only on success, so a genuinely offline daemon
     * leaves the configuration untouched and the original error intact.
     */
    health: async (signal, baseUrlOverride) => {
      if (baseUrlOverride !== undefined) return client(baseUrlOverride).health(signal);

      const configured = useSettingsStore.getState().ollamaUrl;
      try {
        return await client(configured).health(signal);
      } catch (error) {
        if (configured === MAC_PROXY_URL) throw error;
        const viaProxy = await client(MAC_PROXY_URL)
          .health(signal)
          .catch(() => null);
        if (viaProxy === null) throw error;
        useSettingsStore.getState().setSettings({ ollamaUrl: MAC_PROXY_URL });
        return viaProxy;
      }
    },
    listModels: (signal) => client().listModels(signal),
    showModel: (name, signal) => client().showModel(name, signal),
    embed: (model, input, signal) => client().embed(model, input, signal),
    chat: (request, signal) => client().chat(request, signal),
    generate: (request, signal) => client().generate(request, signal),
  };
}

/**
 * KnowledgeBaseClient façade that resolves the companion URL from settings on
 * every call, mirroring the Ollama façade above.
 */
export function createSettingsBoundKbClient(
  factory: (config: KnowledgeBaseClientConfig) => KnowledgeBaseClient = createKnowledgeBaseClient,
): KnowledgeBaseClient {
  const client = (): KnowledgeBaseClient => factory({ baseUrl: useSettingsStore.getState().kbUrl });
  return {
    health: (signal) => client().health(signal),
    listCollections: (signal) => client().listCollections(signal),
    upsertCollection: (config, signal) => client().upsertCollection(config, signal),
    deleteCollection: (id, signal) => client().deleteCollection(id, signal),
    reindexCollection: (id, full, signal) => client().reindexCollection(id, full, signal),
    query: (query, ids, k, signal) => client().query(query, ids, k, signal),
  };
}

export function createDefaultServices(hostInfo: HostInfo): Services {
  return {
    office: createOfficeService(hostInfo),
    ollama: createSettingsBoundOllamaClient(),
    storage: storageService,
    clipboard: createClipboardService(),
    kb: createSettingsBoundKbClient(),
  };
}

let current: Services | null = null;

/** Called once from main.tsx with the real detected host, before render. */
export function initServices(hostInfo: HostInfo): Services {
  current = createDefaultServices(hostInfo);
  return current;
}

/** Lazily falls back to browser-safe defaults (mock Office) when uninitialized. */
export function getServices(): Services {
  current ??= createDefaultServices(BROWSER_HOST);
  return current;
}

/** Test/dev only — swap implementations. */
export function setServices(overrides: Partial<Services>): void {
  current = { ...getServices(), ...overrides };
}
