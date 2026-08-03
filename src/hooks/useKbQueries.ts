/**
 * Knowledge-base server-cache queries (ARCHITECTURE.md §8; ADR-020), mirroring
 * `useOllamaQueries`. Lives in `hooks/` rather than the feature because both
 * `knowledgebase` (panel) and `settings` (companion status) consume it.
 *
 * A missing companion is an ordinary, expected state — the KB is opt-in — so
 * these queries do not retry aggressively and callers render guidance instead
 * of an error.
 */
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { getServices } from '../app/services';
import type { CollectionStatus, KnowledgeBaseHealth } from '../types/knowledgebase';

export const kbKeys = {
  health: ['kb', 'health'] as const,
  collections: ['kb', 'collections'] as const,
};

/** Matches §8's cadence for the Ollama probe. */
const REFETCH_INTERVAL_MS = 15_000;

export function useKbHealth(enabled: boolean): UseQueryResult<KnowledgeBaseHealth> {
  return useQuery({
    queryKey: kbKeys.health,
    queryFn: ({ signal }) => getServices().kb.health(signal),
    refetchInterval: REFETCH_INTERVAL_MS,
    retry: false,
    enabled,
  });
}

export function useKbCollections(enabled: boolean): UseQueryResult<CollectionStatus[]> {
  return useQuery({
    queryKey: kbKeys.collections,
    queryFn: ({ signal }) => getServices().kb.listCollections(signal),
    refetchInterval: REFETCH_INTERVAL_MS,
    retry: false,
    enabled,
  });
}
