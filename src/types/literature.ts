/**
 * Literature-discovery domain (ARCHITECTURE.md §6; DECISIONS.md ADR-028,
 * ADR-029).
 *
 * Type-only and import-free, like `types/knowledgebase.ts`: these shapes are
 * shared by the literature service, the feature store, and (later) Phase 16's
 * citation generation, so no runtime value is exported from here.
 *
 * Two decisions are encoded structurally rather than left to convention.
 *
 * 1. **Records are CSL-JSON-shaped from the start** (ADR-029). Field names
 *    follow CSL where CSL has one — `containerTitle` for `container-title`,
 *    `issued` as date-parts, authors as family/given — so Phase 16 inherits a
 *    usable shape instead of retrofitting a normalisation.
 *
 * 2. **"Not checked" is not "absent"** (ADR-029's hard UI rule). Credibility
 *    signals are grouped by the source that provides them and each group is
 *    nullable: `null` means that source was never consulted (disabled, offline,
 *    or failed), while a present group with false/null fields means the check
 *    ran and found nothing. The rule is therefore impossible to violate by
 *    accident — there is no single flat bag of booleans in which the two states
 *    could be confused.
 */

/** Sources GRETTA can search or attribute discovered records to (ADR-031). */
export type LiteratureSourceId = 'pubmed' | 'crossref' | 'biorxiv' | 'medrxiv' | 'openalex';

/** CSL-compatible contributor. `given` is null for corporate/consortium names. */
export interface Contributor {
  family: string;
  given: string | null;
}

/** CSL `issued` reduced to what scholarly APIs actually supply. */
export interface IssuedDate {
  year: number;
  month: number | null;
  day: number | null;
}

/**
 * Work type. Distinguishing an article from an editorial or erratum matters:
 * ADR-029 shows it as a credibility signal, and a `preprint` is labelled rather
 * than demoted, since bioRxiv and medRxiv are requested sources.
 */
export type WorkType =
  | 'article'
  | 'preprint'
  | 'review'
  | 'editorial'
  | 'letter'
  | 'erratum'
  | 'chapter'
  | 'dataset'
  | 'other';

/** One discovered work. Abstracts are data, never markup (ARCHITECTURE §13.1). */
export interface LiteratureRecord {
  /** Stable local id, derived from the best available external identifier. */
  id: string;
  doi: string | null;
  pmid: string | null;
  arxivId: string | null;
  openAlexId: string | null;
  title: string;
  authors: Contributor[];
  /** Journal, repository, or conference name (CSL `container-title`). */
  containerTitle: string | null;
  issued: IssuedDate | null;
  /** Plain text; null when the source supplies none (common for Crossref). */
  abstract: string | null;
  type: WorkType;
  /** Landing page for the user to open in their browser, never in the pane. */
  url: string | null;
  /** Which enabled source returned this record. */
  discoveredVia: LiteratureSourceId;
}

/** Venue- and work-level signals from OpenAlex (field names verified against its schema). */
export interface OpenAlexSignals {
  venueKnown: boolean;
  venueInDoaj: boolean | null;
  venueIsOa: boolean | null;
  /** `summary_stats.2yr_mean_citedness` — an impact-factor-like venue average. */
  venueMeanCitedness: number | null;
  venueHIndex: number | null;
  /** `apc_usd`; a charge with no DOAJ listing is one input to the ADR-029 filter. */
  venueApcUsd: number | null;
  /** Field-weighted citation impact — age- and field-normalised, unlike a raw count. */
  fwci: number | null;
  /** `cited_by_percentile_year`, 0..100. */
  citedByPercentileYear: number | null;
  /** Raw count: shown as context and log-scaled for `litCitationImpactWeight` (ADR-029). */
  citedByCount: number | null;
  isParatext: boolean | null;
}

/** Signals only PubMed can give. MEDLINE indexing is a curation decision, not mere presence. */
export interface PubMedSignals {
  inPubMed: boolean;
  medlineIndexed: boolean | null;
}

/** Registration-quality signals from Crossref's own metadata. */
export interface CrossrefSignals {
  registered: boolean;
  hasDepositedReferences: boolean | null;
  memberName: string | null;
}

/**
 * Credibility evidence, grouped by provenance. A `null` group means the source
 * was not consulted and must render as "not checked" — never as an absent
 * signal (ADR-029).
 */
export interface CredibilitySignals {
  openAlex: OpenAlexSignals | null;
  pubmed: PubMedSignals | null;
  crossref: CrossrefSignals | null;
}

/**
 * A post-publication update. The *type* is preserved deliberately: ADR-029
 * rejects OpenAlex's single `is_retracted` boolean because collapsing these
 * into one flag has already mislabelled corrected papers as retracted.
 *
 * The list follows what the two upstream vocabularies actually emit, which are
 * not identical to each other — Crossref's Crossmark schema carries
 * `partial_retraction` and `removal`, and Retraction Watch additionally records
 * `Reinstatement`, a notice that withdraws a withdrawal. A taxonomy without
 * reinstatement would leave a cleared paper flagged forever.
 */
export type UpdateType =
  | 'retraction'
  | 'partial-retraction'
  | 'withdrawal'
  | 'removal'
  | 'expression-of-concern'
  | 'correction'
  | 'reinstatement'
  | 'other';

export interface WorkUpdate {
  type: UpdateType;
  /** Crossref's `source`: `publisher` or `retraction-watch`. */
  source: string;
  /** DOI of the notice itself, so the user can read it rather than a summary. */
  noticeDoi: string | null;
  /** The notice's own label, never paraphrased (ADR-029). */
  label: string;
  date: string | null;
}

/**
 * Update status for a record. `notChecked` is explicit for the same reason the
 * signal groups are nullable: silence must not read as an all-clear, and
 * Crossref itself notes expression-of-concern coverage is incomplete.
 */
export interface UpdateStatus {
  checked: boolean;
  updates: WorkUpdate[];
}

/** Local stance classification (ADR-029). Advisory triage, never evidence. */
export type Stance = 'supports' | 'contradicts' | 'mixed' | 'unclear';

export interface StanceAssessment {
  stance: Stance;
  /**
   * Verbatim span quoted from the abstract. Verified to occur in the abstract
   * before display; a span that does not is discarded as fabrication (ADR-029).
   */
  evidence: string;
  /** Model that produced it, so a label can be re-read in light of its author. */
  model: string;
  assessedAt: string;
}

/**
 * How far a record has travelled toward being usable as context (ADR-028).
 * `queued` records never enter a prompt; only `verified` ones do, and they do
 * it as ordinary knowledge-base documents rather than through any literature
 * code path.
 */
export type TrustTier = 'queued' | 'verified';

/** A record plus everything GRETTA has learned about it. */
export interface AssessedRecord {
  record: LiteratureRecord;
  signals: CredibilitySignals;
  updates: UpdateStatus;
  /** Cosine similarity to the user's passage, 0..1; null when not re-ranked. */
  relevance: number | null;
  /** null until the user asks for it — stance is on demand (ADR-029). */
  stance: StanceAssessment | null;
  tier: TrustTier;
}

/** Open-access availability, which decides whether ingest is even offered. */
export interface OpenAccessLocation {
  url: string;
  /** SPDX-ish licence string when the source declares one. */
  license: string | null;
  /** Host the PDF would be fetched from; checked against the allowlist. */
  host: string;
}
