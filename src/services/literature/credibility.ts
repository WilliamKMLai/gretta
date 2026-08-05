/**
 * Credibility signals and post-publication updates (DECISIONS.md ADR-029).
 *
 * Two rules from that ADR are enforced here rather than left to the UI.
 *
 * 1. **Signals are shown, never summed.** There is no composite score in this
 *    module and there should never be one. A single number would be
 *    unfalsifiable to the reader, would encode contested weights silently, and
 *    could not be argued with. What comes out instead is a list of named checks,
 *    each carrying what it means and where it came from.
 *
 * 2. **"Not checked" is not "absent".** A record nobody verified must never
 *    look like a record that failed verification. The type system already
 *    separates them (`CredibilitySignals` groups are nullable per source), and
 *    `verificationStatus` keeps them apart in the one place where the
 *    distinction has a visible consequence: whether a result gets collapsed
 *    behind the "limited verification" disclosure.
 *
 * Pure: imports only types, tested directly.
 */
import type {
  CredibilitySignals,
  UpdateStatus,
  UpdateType,
  WorkUpdate,
} from '../../types/literature';

/**
 * Provisional thresholds. ADR-029 records the signal set and its cut-offs as an
 * open question to be tuned against real result sets — deliberately including
 * non-Anglophone ones, since indexing coverage is uneven and a missing signal is
 * often missing coverage rather than missing rigour.
 */
export const NEGLIGIBLE_CITEDNESS = 0.2;

export type BadgeTone = 'positive' | 'neutral' | 'caution' | 'unchecked';

/** One named check, ready to render. `detail` is the tooltip: what and whence. */
export interface CredibilityBadge {
  id: string;
  label: string;
  detail: string;
  tone: BadgeTone;
}

/**
 * Whether a record cleared baseline verification.
 *
 * - `verified` — at least one consulted source vouched for the record.
 * - `limited` — sources were consulted and none did. These are collapsed behind
 *   a disclosure, never dropped.
 * - `not-checked` — no source was consulted at all. Rendered as "not checked"
 *   and **never** collapsed, because collapsing it would present ignorance as a
 *   finding.
 */
export type VerificationStatus = 'verified' | 'limited' | 'not-checked';

export function verificationStatus(signals: CredibilitySignals): VerificationStatus {
  const { openAlex, pubmed, crossref } = signals;
  if (openAlex === null && pubmed === null && crossref === null) return 'not-checked';

  const vouched =
    (crossref?.registered ?? false) ||
    (pubmed?.medlineIndexed ?? false) ||
    (openAlex?.venueKnown ?? false);

  return vouched ? 'verified' : 'limited';
}

/**
 * The APC pattern ADR-029 names: a venue that charges to publish, is absent
 * from DOAJ, and is barely cited. Any one of those alone is unremarkable —
 * plenty of reputable journals charge, and DOAJ only lists open-access titles —
 * so the caution fires only on the conjunction, and even then it reports the
 * combination rather than reaching a verdict about the journal.
 */
function chargesWithoutStanding(signals: CredibilitySignals, threshold: number): boolean {
  const openAlex = signals.openAlex;
  if (openAlex === null) return false;
  const apc = openAlex.venueApcUsd;
  if (apc === null || apc <= 0) return false;
  if (openAlex.venueInDoaj === true) return false;
  const citedness = openAlex.venueMeanCitedness;
  return citedness !== null && citedness < threshold;
}

/**
 * Turns the evidence into a list of named checks. Order is fixed so the badges
 * do not reshuffle between records, which would make two results hard to
 * compare at a glance in a 320 px pane.
 */
export function describeCredibility(
  signals: CredibilitySignals,
  minVenueCitedness: number = NEGLIGIBLE_CITEDNESS,
): CredibilityBadge[] {
  const badges: CredibilityBadge[] = [];
  const { crossref, pubmed, openAlex } = signals;

  if (crossref === null) {
    badges.push({
      id: 'crossref',
      label: 'Registration not checked',
      detail: 'Crossref was not consulted, so nothing is known either way.',
      tone: 'unchecked',
    });
  } else {
    badges.push({
      id: 'crossref',
      label: crossref.registered ? 'Registered with Crossref' : 'No Crossref record',
      detail: crossref.registered
        ? `Has a registered DOI${crossref.memberName === null ? '' : ` via ${crossref.memberName}`}.`
        : 'No DOI registration was found for this record.',
      tone: crossref.registered ? 'positive' : 'caution',
    });
  }

  if (pubmed === null) {
    badges.push({
      id: 'medline',
      label: 'MEDLINE not checked',
      detail: 'PubMed was not consulted, so indexing status is unknown.',
      tone: 'unchecked',
    });
  } else if (pubmed.medlineIndexed === true) {
    badges.push({
      id: 'medline',
      label: 'MEDLINE-indexed',
      detail: "The journal passed the US National Library of Medicine's selection review.",
      tone: 'positive',
    });
  } else if (pubmed.inPubMed) {
    badges.push({
      id: 'medline',
      label: 'In PubMed, not MEDLINE-indexed',
      detail: 'Present in PubMed, which is broader than the curated MEDLINE subset.',
      tone: 'neutral',
    });
  }

  if (openAlex === null) {
    badges.push({
      id: 'venue',
      label: 'Venue not checked',
      detail: 'OpenAlex was not consulted, so no venue signals are available.',
      tone: 'unchecked',
    });
    return badges;
  }

  if (openAlex.venueInDoaj === true) {
    badges.push({
      id: 'doaj',
      label: 'Listed in DOAJ',
      detail: 'The journal appears in the Directory of Open Access Journals.',
      tone: 'positive',
    });
  }

  if (openAlex.citedByCount !== null) {
    /*
     * The raw count, shown because researchers read it directly — it is a
     * common first-pass filter for how much a paper has been engaged with.
     *
     * Displayed, never ranked on (ADR-029). A raw count rewards age: a 2015
     * paper has had a decade to accumulate what a 2025 one has had months for,
     * so sorting by it would bury exactly the recent work a "recent advances"
     * passage is looking for. The percentile badge below is the age-adjusted
     * companion, and it is the one to compare across years.
     */
    badges.push({
      id: 'citations',
      label: `${openAlex.citedByCount.toLocaleString()} citations`,
      detail:
        'Total citations recorded by OpenAlex. Compare only within a publication ' +
        'year — older papers have had longer to accumulate them.',
      tone: 'neutral',
    });
  }

  if (openAlex.fwci !== null) {
    badges.push({
      id: 'fwci',
      label: `${openAlex.fwci.toFixed(1)}× field average`,
      detail:
        'Field-weighted citation impact: citations relative to what is typical for ' +
        'this field, year, and work type. 1.0 is average, so this is comparable ' +
        'across disciplines in a way a raw count is not.',
      tone: 'neutral',
    });
  }

  if (openAlex.citedByPercentileYear !== null) {
    badges.push({
      id: 'citation-percentile',
      label: `Top ${String(Math.max(1, Math.round(100 - openAlex.citedByPercentileYear)))}% for its year`,
      detail:
        'Citations relative to work published the same year, so recent papers are ' +
        'not penalised for being recent (OpenAlex).',
      tone: 'neutral',
    });
  }

  if (openAlex.venueMeanCitedness !== null) {
    badges.push({
      id: 'venue-citedness',
      label: `Venue mean citations ${openAlex.venueMeanCitedness.toFixed(1)}`,
      detail:
        'Mean citations per work over two years, across everything the journal ' +
        'published (OpenAlex). This is not the Journal Impact Factor — that counts ' +
        'only selected article types in its denominator and runs much higher for ' +
        'the same journal. It describes the journal, not this paper.',
      tone: 'neutral',
    });
  }

  if (openAlex.isParatext === true) {
    badges.push({
      id: 'paratext',
      label: 'Front or back matter',
      detail: 'Identified as journal apparatus rather than a scholarly work.',
      tone: 'caution',
    });
  }

  if (chargesWithoutStanding(signals, minVenueCitedness)) {
    badges.push({
      id: 'apc-standing',
      label: 'Charges to publish, little citation record',
      detail:
        'This venue charges an article-processing fee, is not listed in DOAJ, and is ' +
        'rarely cited. That combination is worth checking before citing it.',
      tone: 'caution',
    });
  }

  return badges;
}

/** Update types that should stop a user in their tracks, in severity order. */
const BLOCKING_UPDATES: readonly UpdateType[] = [
  'retraction',
  'partial-retraction',
  'withdrawal',
  'removal',
  'expression-of-concern',
];

/**
 * What the post-publication record says about a work.
 *
 * `standsRetracted` exists because a blocking notice is not the last word: a
 * reinstatement withdraws a withdrawal, and a tool that flags a cleared paper
 * forever is making the same class of error as one that flags a corrected paper
 * as retracted. Both notices are returned either way, so the pane can show the
 * sequence rather than a verdict.
 */
export interface UpdateAssessment {
  blocking: WorkUpdate[];
  reinstatements: WorkUpdate[];
  standsRetracted: boolean;
}

function updateTime(update: WorkUpdate): number {
  if (update.date === null) return Number.NaN;
  const parsed = Date.parse(update.date);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/**
 * Assesses post-publication updates.
 *
 * Every returned notice keeps its own label rather than being paraphrased, and
 * names its type explicitly. ADR-029 rejects the single-boolean approach for
 * exactly this reason: telling a researcher a paper is retracted when it was
 * merely corrected is a worse failure than saying nothing, and it is one they
 * cannot detect without redoing the check themselves.
 *
 * An undated reinstatement clears an undated blocking notice — with no ordering
 * to reason from, the more recent *information* is the one that says the
 * concern was resolved, and over-warning here has a real cost: it tells a
 * researcher not to cite sound work.
 */
export function assessUpdates(status: UpdateStatus): UpdateAssessment {
  if (!status.checked) {
    return { blocking: [], reinstatements: [], standsRetracted: false };
  }

  const blocking = status.updates
    .filter((update) => BLOCKING_UPDATES.includes(update.type))
    .sort(
      (left, right) => BLOCKING_UPDATES.indexOf(left.type) - BLOCKING_UPDATES.indexOf(right.type),
    );
  const reinstatements = status.updates.filter((update) => update.type === 'reinstatement');

  if (blocking.length === 0) {
    return { blocking, reinstatements, standsRetracted: false };
  }
  if (reinstatements.length === 0) {
    return { blocking, reinstatements, standsRetracted: true };
  }

  const latestBlocking = Math.max(...blocking.map(updateTime));
  const latestClearing = Math.max(...reinstatements.map(updateTime));
  const undatedEither = Number.isNaN(latestBlocking) || Number.isNaN(latestClearing);

  return {
    blocking,
    reinstatements,
    standsRetracted: undatedEither ? false : latestBlocking > latestClearing,
  };
}

/**
 * Whether the absence of warnings can be presented as reassurance. It cannot
 * unless the check actually ran — and even then only for retractions, because
 * Crossref states that its expression-of-concern and correction coverage is
 * less comprehensive than its retraction coverage. So a clean result is
 * reported as "no retraction found", never as "this paper is fine".
 */
export function canReportClear(status: UpdateStatus): boolean {
  return status.checked;
}
