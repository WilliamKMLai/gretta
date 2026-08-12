/**
 * Ollama server-cache queries (ARCHITECTURE.md §8; ADR-005). TanStack Query
 * owns exactly this: health and the installed-model list. Generation is NOT a
 * query/mutation — it lives in the stream store machine.
 *
 * Lives in `hooks/` rather than in the `ai` feature (ADR-017): both `ai`
 * (ModelPicker, ConnectionBanner) and `settings` (ConnectionSection) consume
 * it, so keeping it inside `ai` forced `settings → ai` while `ai → settings`
 * already existed — a feature-level import cycle. A neutral hook both features
 * may import breaks it.
 */
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { getServices } from '../app/services';
import type { OllamaModel, OllamaModelDetails } from '../services/ollama';

export const ollamaKeys = {
  health: ['ollama', 'health'] as const,
  models: ['ollama', 'models'] as const,
  /** Per-model detail (§8 reserved this key; ADR-034 is its first consumer). */
  model: (name: string) => ['ollama', 'model', name] as const,
};

/** Matches §8: the pane re-checks the daemon every 15 s. */
const REFETCH_INTERVAL_MS = 15_000;

export function useOllamaHealth(): UseQueryResult<{ version: string }> {
  return useQuery({
    queryKey: ollamaKeys.health,
    // The Mac-proxy fallback lives in the settings-bound façade, which already
    // owns URL resolution; a hook may not reach into features (ARCH §5.2).
    queryFn: ({ signal }) => getServices().ollama.health(signal),
    refetchInterval: REFETCH_INTERVAL_MS,
  });
}

export function useModels(): UseQueryResult<OllamaModel[]> {
  return useQuery({
    queryKey: ollamaKeys.models,
    queryFn: ({ signal }) => getServices().ollama.listModels(signal),
    refetchInterval: REFETCH_INTERVAL_MS,
  });
}

/**
 * `POST /api/show` for ONE model — the capability probe (ADR-034).
 *
 * Never poll and never refetch: a model tag's capabilities cannot change under
 * us, so this is fetched once per tag per session and cached forever. Pass null
 * to disable, which is what a caller does before a model has been chosen.
 *
 * Deliberately per-model rather than a list. ADR-026 matches embedding models by
 * name substring precisely to avoid one `/api/show` per installed model on every
 * panel open; the question here is asked about the one or two models actually
 * selected, so the cheap answer is to ask.
 */
export function useModelDetails(name: string | null): UseQueryResult<OllamaModelDetails> {
  return useQuery({
    queryKey: ollamaKeys.model(name ?? ''),
    queryFn: ({ signal }) => getServices().ollama.showModel(name ?? '', signal),
    enabled: name !== null && name !== '',
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    // A model that isn't pulled yet 404s; one retry is enough to cover a blip
    // without making every missing-model case wait through a backoff ladder.
    retry: 1,
  });
}
