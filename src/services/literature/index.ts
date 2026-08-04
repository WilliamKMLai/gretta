/**
 * Public surface of services/literature. Other layers import from here only
 * (`boundaries/entry-point`, ARCHITECTURE.md §5.2).
 *
 * Note what is deliberately absent: nothing here is reachable from the
 * generation path. ADR-028 settles that literature results enter a prompt only
 * after being ingested into the knowledge base, as ordinary documents, so there
 * is no context provider to export and `useGeneration` never imports this
 * module.
 */
export type { ApprovedQuery, QueryApproval, QueryRejection } from './query';
export { MAX_QUERY_CHARS, approveQuery, normalizeQuery, queryText } from './query';

export type { Rankable, Ranked } from './rank';
export {
  applyImpactBoost,
  cosineSimilarity,
  embeddableText,
  lexicalOverlap,
  rankByOverlap,
  rankByRelevance,
  tokenize,
} from './rank';

export type {
  BadgeTone,
  CredibilityBadge,
  UpdateAssessment,
  VerificationStatus,
} from './credibility';
export {
  NEGLIGIBLE_CITEDNESS,
  assessUpdates,
  canReportClear,
  describeCredibility,
  verificationStatus,
} from './credibility';

export type {
  HttpTransport,
  LiteratureClientConfig,
  LiteratureSearchClient,
  UpdateLookupClient,
} from './client.types';
export { createCrossrefClient } from './crossref';

export type { RateLimit } from './etiquette';
export {
  FALLBACK_INTERVAL_MS,
  MAX_BACKOFF_MS,
  backoffMs,
  buildUserAgent,
  minIntervalMs,
  parseRateLimit,
  withContact,
} from './etiquette';

export { abstractToText, firstNonEmpty } from './jats';

export type { OpenAlexClient, OpenAlexEnrichment } from './openalex';
export { ENRICH_CHUNK_SIZE, createOpenAlexClient } from './openalex';
export { fromInvertedIndex } from './openalex.schemas';

export type { PubMedClient, PubMedSearchResult } from './pubmed';
export { createPubMedClient } from './pubmed';
export type { PubMedArticle } from './pubmed.schemas';
export { parseArticleSet, parsePmidList } from './pubmed.schemas';

export type { PreprintServer } from './crossref';
