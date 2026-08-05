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
import type { OllamaModel } from '../services/ollama';

export const ollamaKeys = {
  health: ['ollama', 'health'] as const,
  models: ['ollama', 'models'] as const,
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
