/**
 * Public surface of features/literature.
 *
 * Note what is absent: no `ContextProvider`. ADR-028 settles that literature
 * reaches a generation only after full text is ingested into the knowledge
 * base, as an ordinary document, so nothing here is reachable from the
 * generation path.
 */
export { LiteraturePanel } from './LiteraturePanel';
export { LiteratureAdvancedParams } from './LiteratureAdvancedParams';
export { LiteratureHistoryList } from './LiteratureHistoryList';
export { LiteratureResultList } from './LiteratureResultList';
export { ResultCard } from './LiteratureResultCard';
export { useLiteratureStore } from './literature.store';
export type { LiteraturePhase, RankingMode } from './literature.store';
export { useLiteratureSearch } from './useLiteratureSearch';
export { DRAFT_QUERY_SYSTEM, buildDraftPrompt, extractDraftedQuery } from './draftQuery';
export { clearCache, listEntries } from './cache';
export type { CacheEntry } from './cache';
