/**
 * Credibility tests (DECISIONS.md ADR-029). The central case is the one that is
 * easy to get wrong and invisible when wrong: an unchecked record must never be
 * treated as a failed one.
 */
import { describe, expect, it } from 'vitest';
import type { CredibilitySignals, UpdateStatus } from '../../types/literature';
import {
  assessUpdates,
  canReportClear,
  describeCredibility,
  verificationStatus,
} from './credibility';

const nothingChecked: CredibilitySignals = { openAlex: null, pubmed: null, crossref: null };

const reputable: CredibilitySignals = {
  crossref: { registered: true, hasDepositedReferences: true, memberName: 'Springer Nature' },
  pubmed: { inPubMed: true, medlineIndexed: true },
  openAlex: {
    venueKnown: true,
    venueInDoaj: false,
    venueIsOa: false,
    venueMeanCitedness: 42.1,
    venueHIndex: 1200,
    venueApcUsd: 11390,
    fwci: 3.2,
    citedByPercentileYear: 98,
    citedByCount: 412,
    isParatext: false,
  },
};

const checkedAndUnvouched: CredibilitySignals = {
  crossref: { registered: false, hasDepositedReferences: false, memberName: null },
  pubmed: { inPubMed: false, medlineIndexed: false },
  openAlex: {
    venueKnown: false,
    venueInDoaj: null,
    venueIsOa: null,
    venueMeanCitedness: null,
    venueHIndex: null,
    venueApcUsd: null,
    fwci: null,
    citedByPercentileYear: null,
    citedByCount: null,
    isParatext: null,
  },
};

describe('verificationStatus', () => {
  it('reports not-checked when no source was consulted', () => {
    // The rule that matters: ignorance is not a finding, and must not be
    // collapsed behind a "limited verification" disclosure.
    expect(verificationStatus(nothingChecked)).toBe('not-checked');
  });

  it('reports verified when a consulted source vouches for the record', () => {
    expect(verificationStatus(reputable)).toBe('verified');
  });

  it('reports limited only when sources were consulted and none vouched', () => {
    expect(verificationStatus(checkedAndUnvouched)).toBe('limited');
  });

  it('accepts a Crossref registration alone as verification', () => {
    expect(
      verificationStatus({
        crossref: { registered: true, hasDepositedReferences: null, memberName: null },
        pubmed: null,
        openAlex: null,
      }),
    ).toBe('verified');
  });

  it('does not treat a partially checked record as fully unchecked', () => {
    expect(
      verificationStatus({
        crossref: { registered: false, hasDepositedReferences: null, memberName: null },
        pubmed: null,
        openAlex: null,
      }),
    ).toBe('limited');
  });
});

describe('describeCredibility', () => {
  it('marks unconsulted sources as not checked, never as absent', () => {
    const badges = describeCredibility(nothingChecked);
    expect(badges.every((badge) => badge.tone === 'unchecked')).toBe(true);
    expect(badges.map((badge) => badge.label).join(' ')).toContain('not checked');
  });

  it('distinguishes MEDLINE indexing from mere PubMed presence', () => {
    const badges = describeCredibility({
      crossref: null,
      pubmed: { inPubMed: true, medlineIndexed: false },
      openAlex: null,
    });
    const medline = badges.find((badge) => badge.id === 'medline');
    expect(medline?.label).toContain('not MEDLINE-indexed');
    expect(medline?.tone).toBe('neutral');
  });

  it('flags the charge-without-standing combination, not its parts', () => {
    const predatoryish: CredibilitySignals = {
      crossref: { registered: true, hasDepositedReferences: false, memberName: null },
      pubmed: null,
      openAlex: {
        venueKnown: true,
        venueInDoaj: false,
        venueIsOa: true,
        venueMeanCitedness: 0.05,
        venueHIndex: 3,
        venueApcUsd: 1400,
        fwci: null,
        citedByPercentileYear: null,
        citedByCount: 0,
        isParatext: null,
      },
    };
    expect(describeCredibility(predatoryish).some((badge) => badge.id === 'apc-standing')).toBe(
      true,
    );
  });

  it('does not flag a reputable journal merely for charging a large APC', () => {
    // Nature charges more than most predatory venues do; the fee alone says nothing.
    expect(describeCredibility(reputable).some((badge) => badge.id === 'apc-standing')).toBe(false);
  });

  it('describes venue citedness as a property of the journal, not the paper', () => {
    const badge = describeCredibility(reputable).find((entry) => entry.id === 'venue-citedness');
    expect(badge?.detail).toContain('not this paper');
  });

  it('shows the raw citation count, which researchers read directly', () => {
    const badge = describeCredibility(reputable).find((entry) => entry.id === 'citations');
    expect(badge?.label).toBe('412 citations');
    // The caveat travels with the number: a raw count rewards age.
    expect(badge?.detail).toContain('within a publication');
  });

  it('shows field-weighted impact alongside it, which a raw count cannot give', () => {
    const badge = describeCredibility(reputable).find((entry) => entry.id === 'fwci');
    expect(badge?.label).toBe('3.2× field average');
  });

  it('omits citation badges entirely when OpenAlex was not consulted', () => {
    const ids = describeCredibility(nothingChecked).map((badge) => badge.id);
    expect(ids).not.toContain('citations');
    expect(ids).not.toContain('fwci');
  });

  it('never emits a summed or composite score', () => {
    const ids = describeCredibility(reputable).map((badge) => badge.id);
    expect(ids).not.toContain('score');
    expect(ids).not.toContain('quality');
  });
});

describe('assessUpdates', () => {
  const retraction = {
    type: 'retraction' as const,
    source: 'retraction-watch',
    noticeDoi: '10.1000/notice',
    label: 'Retraction: Effects of X on Y',
    date: '2024-02-01',
  };
  const correction = {
    type: 'correction' as const,
    source: 'publisher',
    noticeDoi: null,
    label: 'Correction to Table 2',
    date: '2024-01-05',
  };
  const reinstatement = {
    type: 'reinstatement' as const,
    source: 'retraction-watch',
    noticeDoi: null,
    label: 'Reinstatement following investigation',
    date: '2024-09-01',
  };

  it('reports nothing when the check has not run', () => {
    const status: UpdateStatus = { checked: false, updates: [retraction] };
    expect(assessUpdates(status)).toMatchObject({ blocking: [], standsRetracted: false });
  });

  it('does not treat a correction as a retraction', () => {
    // The failure this prevents: OpenAlex's single boolean marked the Corman
    // et al. RT-PCR paper retracted when it had only been corrected.
    const status: UpdateStatus = { checked: true, updates: [correction] };
    expect(assessUpdates(status)).toMatchObject({ blocking: [], standsRetracted: false });
  });

  it('flags a retraction with no reinstatement', () => {
    const status: UpdateStatus = { checked: true, updates: [retraction] };
    expect(assessUpdates(status).standsRetracted).toBe(true);
  });

  it('clears a retraction superseded by a later reinstatement', () => {
    const status: UpdateStatus = { checked: true, updates: [retraction, reinstatement] };
    const assessment = assessUpdates(status);
    expect(assessment.standsRetracted).toBe(false);
    // Both notices are still returned, so the pane can show the sequence.
    expect(assessment.blocking).toHaveLength(1);
    expect(assessment.reinstatements).toHaveLength(1);
  });

  it('keeps the flag when the reinstatement predates the retraction', () => {
    const status: UpdateStatus = {
      checked: true,
      updates: [retraction, { ...reinstatement, date: '2023-01-01' }],
    };
    expect(assessUpdates(status).standsRetracted).toBe(true);
  });

  it('errs toward clearing when either notice is undated', () => {
    // Over-warning tells a researcher not to cite sound work.
    const status: UpdateStatus = {
      checked: true,
      updates: [{ ...retraction, date: null }, reinstatement],
    };
    expect(assessUpdates(status).standsRetracted).toBe(false);
  });

  it('preserves notice labels verbatim rather than paraphrasing', () => {
    const status: UpdateStatus = { checked: true, updates: [retraction] };
    expect(assessUpdates(status).blocking[0]?.label).toBe('Retraction: Effects of X on Y');
  });

  it('treats partial retraction and removal as blocking', () => {
    const status: UpdateStatus = {
      checked: true,
      updates: [
        { ...retraction, type: 'partial-retraction' as const },
        { ...retraction, type: 'removal' as const },
      ],
    };
    expect(assessUpdates(status).blocking).toHaveLength(2);
  });

  it('orders retractions ahead of expressions of concern', () => {
    const concern = {
      type: 'expression-of-concern' as const,
      source: 'publisher',
      noticeDoi: null,
      label: 'Expression of Concern',
      date: null,
    };
    const status: UpdateStatus = { checked: true, updates: [concern, retraction] };
    expect(assessUpdates(status).blocking.map((update) => update.type)).toEqual([
      'retraction',
      'expression-of-concern',
    ]);
  });
});

describe('canReportClear', () => {
  it('refuses to present an unchecked record as clear', () => {
    expect(canReportClear({ checked: false, updates: [] })).toBe(false);
  });

  it('allows a clear report once the check has actually run', () => {
    expect(canReportClear({ checked: true, updates: [] })).toBe(true);
  });
});
