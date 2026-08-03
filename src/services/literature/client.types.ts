/**
 * Literature-source boundary contracts (ARCHITECTURE.md §7; DECISIONS.md
 * ADR-028). Each source lives behind its own client with its own transport
 * seam, so `services/literature` is the third and last place in the app
 * permitted to call `fetch` (after `services/ollama` and
 * `services/knowledgebase`).
 *
 * Search takes an `ApprovedQuery`, never a string. That is ADR-028's
 * transmission gate expressed in the type system: a selection, a prompt draft,
 * or a paragraph of the user's manuscript cannot be handed to a network call
 * without passing `approveQuery` first, and no amount of later refactoring can
 * quietly reintroduce the possibility.
 */
import type { LiteratureRecord, UpdateStatus } from '../../types/literature';
import type { ApprovedQuery } from './query';

/** Injectable HTTP seam — the sole `fetch` call site, swappable in tests. */
export type HttpTransport = (url: string, init: RequestInit) => Promise<Response>;

/** A source that can be searched. */
export interface LiteratureSearchClient {
  readonly id: string;
  /**
   * Runs a search. `limit` caps the candidate pool the local re-ranker will
   * embed (ADR-029), which is why it is the caller's decision rather than the
   * client's: embedding cost is a local-compute concern.
   */
  search(query: ApprovedQuery, limit: number, signal?: AbortSignal): Promise<LiteratureRecord[]>;
}

/** A source that can report post-publication updates for known identifiers. */
export interface UpdateLookupClient {
  /**
   * Looks up retraction and correction notices by DOI.
   *
   * Every requested DOI appears in the result, including ones with nothing
   * recorded, because `UpdateStatus.checked` is how the caller distinguishes
   * "checked, nothing found" from "never checked" (ADR-029) — an omitted key
   * would collapse exactly the distinction the type exists to preserve.
   */
  lookupUpdates(dois: readonly string[], signal?: AbortSignal): Promise<Map<string, UpdateStatus>>;
}

export interface LiteratureClientConfig {
  /**
   * Contact address for the polite pool. Optional by design: it is deliberate
   * PII egress (ADR-028), so an absent address degrades to the public pool
   * rather than blocking the feature or substituting a placeholder.
   */
  contactEmail?: string | null;
  /**
   * OpenAlex API key. Free but required since February 2026, when keys replaced
   * the `mailto` polite pool. Ignored by the other clients.
   */
  apiKey?: string | null;
  /** App version, for client identification where a header can be sent. */
  version?: string;
  transport?: HttpTransport;
  timeoutMs?: number;
  /** Overridable for tests; defaults to the source's public endpoint. */
  baseUrl?: string;
  /**
   * Starting pace between requests, before a server advertises its own limit.
   *
   * Exists so tests can set it to zero. They previously slept for real — a
   * second between every pair of requests — which made the unit suite spend
   * seconds doing nothing and, worse, put timing-sensitive tests near their
   * budget under parallel load. Politeness belongs in production; a mocked
   * transport has nobody to be polite to.
   */
  initialPacingMs?: number;
}
