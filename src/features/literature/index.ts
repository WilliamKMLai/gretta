/**
 * Public surface of features/literature.
 *
 * Note what is absent: no `ContextProvider`. ADR-028 settles that literature
 * reaches a generation only after full text is ingested into the knowledge
 * base, as an ordinary document, so nothing here is reachable from the
 * generation path.
 */
export { LiteraturePanel } from './LiteraturePanel';
export { LiteratureResultList } from './LiteratureResultList';
export { useLiteratureStore } from './literature.store';
export type { LiteraturePhase, RankingMode } from './literature.store';
export { useLiteratureSearch } from './useLiteratureSearch';
export { DRAFT_QUERY_SYSTEM, buildDraftPrompt, extractDraftedQuery } from './draftQuery';
