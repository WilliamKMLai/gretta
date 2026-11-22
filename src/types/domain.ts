/**
 * GRETTA core domain model (ARCHITECTURE.md §6).
 *
 * These are the shapes shared across features, stores, and services. Persisted
 * variants of these types get matching Zod schemas in their owning feature
 * (Phase 5) wrapped in a versioned `{ version, data }` envelope (ADR-006).
 */

import type { RetrievedChunk } from './knowledgebase';

/** Chat participant role, matching Ollama's `/api/chat` message roles. */
export type Role = 'system' | 'user' | 'assistant';

/**
 * Office host platform as reported by `Office.onReady`. Lives in the shared
 * types layer because both services/office (HostInfo) and services/ollama
 * (mixed-content discrimination) need it, and services may not cross-import
 * (ARCHITECTURE.md §5.2).
 */
export type HostPlatform = 'PC' | 'Mac' | 'OfficeOnline' | 'unknown';

/** Timing/throughput metadata reported by Ollama's final stream chunk. */
export interface GenerationStats {
  /** Wall-clock duration of the whole request, in milliseconds. */
  totalDurationMs: number;
  /** Number of output (completion) tokens generated. */
  evalCount: number;
  /** Number of prompt tokens evaluated. */
  promptEvalCount: number;
  /** Derived output speed: evalCount over generation time. */
  tokensPerSecond: number;
}

/** How a generation ended — recorded so partial results stay explicable. */
export type GenerationOutcome = 'completed' | 'cancelled' | 'error';

/** A document action the user applied to a result (ADR-021). */
export interface AppliedAction {
  kind: 'insert' | 'replace' | 'append' | 'comment';
  /** ISO 8601 timestamp of when it was applied. */
  at: string;
}

/**
 * One generation, start to finish (ADR-021).
 *
 * Generation is single-shot: each run sends one prompt and produces one
 * response, with prior runs never resent. A record is therefore the natural
 * unit of history — self-contained, independently viewable, re-runnable, and
 * exportable — rather than a turn inside a thread that implies a continuity the
 * engine does not provide. Keeping one record per run is also what keeps
 * provenance unambiguous: these `sources` are exactly the excerpts that fed
 * *this* response (ADR-020).
 */
export interface GenerationRecord {
  /** Stable unique id (ULID-style, generated client-side). */
  id: string;
  /** ISO 8601 creation timestamp; also the list's sort key. */
  createdAt: string;
  /** The prompt text the user wrote. */
  prompt: string;
  /** The response, which may be partial when cancelled or interrupted. */
  response: string;
  /** Model that produced it. */
  model: string;
  /** How the run ended. */
  outcome: GenerationOutcome;
  /** Built-in or custom template used, when the run came from one. */
  templateId?: string;
  templateName?: string;
  /** Document context the prompt drew on, when any. */
  contextSource?: ContextSource;
  /**
   * A bounded excerpt of the document text that was actually used.
   *
   * `contextSource` alone records only *which kind* of context was captured —
   * selection, paragraph, whole document — which is the worst of both worlds: it
   * implies provenance while withholding the one thing that would establish it.
   * A record showing sources but not the passage they were retrieved for cannot
   * be audited later, when the reason for a citation is exactly what has been
   * forgotten.
   *
   * Bounded rather than complete, deliberately. History is capped at 200
   * records in browser storage, and a whole-document capture could be megabytes;
   * storing the head of it plus the true length keeps a record recognisable
   * without letting one generation crowd out two hundred others.
   */
  contextExcerpt?: ContextExcerpt;
  /** Generation metadata; absent when the run never completed. */
  stats?: GenerationStats;
  /** Knowledge-base excerpts that fed this run, for citation (ADR-020). */
  sources?: RetrievedChunk[];
  /** Set when the user put this result into the document. */
  applied?: AppliedAction;
}

/** Document context variables a prompt template can interpolate. */
export type PromptContextVar = 'selection' | 'paragraph' | 'document' | 'input';

/** A truncated record of the document text a generation drew on. */
export interface ContextExcerpt {
  /** The opening of the captured text, trimmed to `CONTEXT_EXCERPT_CHARS`. */
  text: string;
  /** Length of the original capture, so truncation is visible rather than silent. */
  totalChars: number;
}

/** What feeds the prompt's document-context slot; `'none'` = prompt text only. */
export type ContextSource = 'none' | Exclude<PromptContextVar, 'input'>;

/** Grouping used by the prompt picker. */
export type PromptCategory =
  'scientific' | 'editing' | 'style' | 'grants' | 'communication' | 'custom';

/**
 * A reusable prompt definition. Built-ins ship in `features/prompts/builtins.ts`;
 * user-defined templates persist through the storage service.
 */
export interface PromptTemplate {
  id: string;
  name: string;
  category: PromptCategory;
  /** One-line description shown in the picker. */
  description: string;
  /** System prompt sent with every request built from this template. */
  system: string;
  /**
   * User-message template. May reference `{{selection}}`, `{{paragraph}}`,
   * `{{document}}`, and `{{input}}`; interpolation is literal substitution
   * with no expression language (ADR-007).
   */
  user: string;
  /** Context variables that must be non-empty for this template to run. */
  requires: PromptContextVar[];
  /** True for the templates that ship with GRETTA (read-only in the UI). */
  builtIn: boolean;
  /** Per-template overrides of the user's generation settings. */
  defaults?: Partial<GenerationOptions>;
}

/** Sampling/runtime options forwarded to Ollama's `options` object. */
export interface GenerationOptions {
  /** Sampling temperature, 0–2. */
  temperature: number;
  /** Nucleus sampling probability mass, 0–1. Maps to `top_p`. */
  topP: number;
  /** Top-K sampling cutoff, integer ≥ 0. Maps to `top_k`. */
  topK: number;
  /** Seed for the sampler; reduces run-to-run variance but is not a determinism guarantee (see Settings hint). null omits the field. */
  seed: number | null;
  /** Context window size in tokens. Maps to `num_ctx`. */
  contextLength: number;
}

/** Theme preference; `office` follows the host application's theme. */
export type ThemePreference = 'light' | 'dark' | 'system' | 'office';

/** Persisted application settings (ARCHITECTURE.md §8, owned by features/settings). */
export interface AppSettings extends GenerationOptions {
  /** Base URL of the Ollama daemon, e.g. `http://127.0.0.1:11434`. */
  ollamaUrl: string;
  /** Preferred model; null until the user picks one or discovery selects a default. */
  defaultModel: string | null;
  /** Stream tokens as they arrive (true) or wait for the full response (false). */
  streaming: boolean;
  theme: ThemePreference;
  /** Copy the finished response to the clipboard automatically. */
  autoCopy: boolean;
  /** Insert the finished response at the cursor automatically. */
  autoInsert: boolean;
  /** Percentage of the context window held back for the model's reply (ADR-025). */
  responseReservePct: number;
  /** Master switch for the local knowledge base (RAG); off until opted in. */
  kbEnabled: boolean;
  /** Base URL of the local knowledge-base companion (ADR-020). */
  kbUrl: string;
  /** Embedding model seeded into new collections; per-collection thereafter. */
  defaultEmbeddingModel: string;
  /**
   * Model used for runs that carry images (ADR-034). Null inherits
   * `defaultModel`, which is the common case: most vision models are competent
   * general chat models, so one model usually covers both jobs and a required
   * second choice would be friction bought for nothing.
   *
   * It exists for the other case — someone running a large text model they are
   * happy with, who wants a small vision model beside it rather than switching
   * their default to look at one figure. Whether the resolved model can actually
   * see is detected via `/api/show`, never inferred from its name.
   */
  visionModel: string | null;
  /**
   * Master switch for literature discovery (ADR-028). Off until opted in, and
   * the only setting that permits any outbound request to a third party.
   */
  litEnabled: boolean;
  /**
   * Per-source switches for *search* (ADR-028). These are the security control,
   * not the CSP: the CSP is static and cannot express a toggle, so it bounds the
   * blast radius to a known host list while these decide what is actually
   * contacted. Each is off by default and enabled individually.
   */
  litSources: LiteratureSourceToggles;
  /**
   * Crossref, used for **verification only** — retraction and correction
   * notices (ADR-031).
   *
   * It was a search source and was demoted on evidence: its index is
   * bibliographic with no relevance model, no citation signal, and no recency
   * weighting, and OpenAlex already ingests its metadata. Searching both
   * returned the same records twice, once ranked well and once badly, with the
   * badly-ranked copies diluting the pool. What Crossref alone can do is report
   * a *typed* notice — a 2004 correction and a 2010 retraction as separate
   * entries — which exists nowhere else and is the reason it stays.
   *
   * It receives the DOIs of results being checked, so it learns what is being
   * read rather than what was searched for. Its copy says so.
   */
  litVerification: boolean;
  /**
   * Model used to draft a search query from a selected passage. Null inherits
   * `defaultModel`: a small fast model is often a better drafter than the one
   * chosen for prose, but making that a required choice would tax every user
   * with a decision most do not have the information to make.
   */
  litDraftModel: string | null;
  /**
   * Contact address for the polite pools Crossref and NCBI operate. Deliberate
   * PII egress (ADR-028), so it is optional: blank degrades to the public pool
   * rather than blocking the feature or substituting a placeholder.
   *
   * No longer used for OpenAlex, which retired its `mailto` pool in favour of
   * API keys in February 2026.
   */
  litContactEmail: string;
  /**
   * OpenAlex API key. Required by OpenAlex since February 2026, and only
   * relevant if that optional source is switched on. Free, but an unkeyed
   * caller gets roughly a cent of daily budget before 429s.
   *
   * A key identifies a person to OpenAlex more durably than an email parameter
   * did, so it is stored locally like any other setting and never transmitted
   * anywhere except OpenAlex.
   */
  litOpenAlexKey: string;
  /**
   * Candidates fetched per source before ranking trims the list. Exposed
   * because it trades breadth against latency and embedding cost, and the right
   * value depends on the field: a broad literature rewards a wider pool, a
   * narrow one does not.
   */
  litResultsPerSource: number;
  /**
   * Venue mean-citedness below which a fee-charging, non-DOAJ journal draws a
   * caution (ADR-029). Provisional: the default was chosen without real result
   * sets behind it, and it is exposed so it can be tuned rather than guessed at
   * again.
   */
  litMinVenueCitedness: number;
  /**
   * How much a candidate's log-scaled raw citation count (OpenAlex
   * `citedByCount`, saturating at 200) boosts relevance ranking (ADR-029,
   * fifth amendment; default 0.6). 0 disables the citation boost while keeping
   * supplementary-type demotions in place.
   */
  litCitationImpactWeight: number;
}

/**
 * One switch per searchable source (ADR-031); all default to false. Crossref is
 * deliberately absent here — it is used for retraction verification
 * (`litVerification`) and as the upstream index for bioRxiv/medRxiv.
 */
export interface LiteratureSourceToggles {
  /** Primary. Free, no account, best abstract coverage of any source. */
  pubmed: boolean;
  /** bioRxiv preprints, found through Crossref's keyword search. */
  biorxiv: boolean;
  /** medRxiv preprints, found through Crossref's keyword search. */
  medrxiv: boolean;
  /**
   * OpenAlex. Not primary: since February 2026 it requires an account and
   * meters usage against a daily budget, with a paid tier above it. The key is
   * free, but a core capability depending on someone else's account and
   * allowance is not local-first in the way the rest of GRETTA is.
   */
  openalex: boolean;
}
