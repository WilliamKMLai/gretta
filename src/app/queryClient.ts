/**
 * TanStack Query client (ARCHITECTURE.md §8; ADR-005). Server-cache state
 * only — Ollama health/models/details. Conservative defaults for a local
 * daemon: one retry (typed errors are usually deterministic), no
 * focus-refetch (the 15 s interval in useModels owns freshness).
 */
import { QueryClient } from '@tanstack/react-query';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
    },
  });
}

/** App singleton; tests build their own via createQueryClient(). */
export const queryClient = createQueryClient();
