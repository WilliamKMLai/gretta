/**
 * Query-gate tests (DECISIONS.md ADR-028). These guard a privacy rule rather
 * than a behaviour, so they are written around the ways the gate could be
 * bypassed, not only the ways it could be used.
 */
import { describe, expect, it } from 'vitest';
import { MAX_QUERY_CHARS, approveQuery, normalizeQuery, queryText } from './query';

describe('normalizeQuery', () => {
  it('collapses whitespace runs and trims', () => {
    expect(normalizeQuery('  base   editing    hepatocyte ')).toBe('base editing hepatocyte');
  });

  it('leaves line breaks alone so approveQuery can still see them', () => {
    expect(normalizeQuery('one\ntwo')).toContain('\n');
  });
});

describe('approveQuery', () => {
  it('approves an ordinary keyword query', () => {
    const result = approveQuery('CRISPR base editing off-target hepatocyte');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(queryText(result.query)).toBe('CRISPR base editing off-target hepatocyte');
    }
  });

  it('rejects an empty or whitespace-only query', () => {
    expect(approveQuery('   ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(approveQuery('')).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('rejects multi-line input rather than flattening it', () => {
    // Flattening would transmit a pasted paragraph while appearing to comply.
    const result = approveQuery('We show that base editing\nreduces off-target effects.');
    expect(result).toMatchObject({ ok: false, reason: 'multiline' });
  });

  it('rejects a query over the character cap', () => {
    const result = approveQuery('a'.repeat(MAX_QUERY_CHARS + 1));
    expect(result).toMatchObject({ ok: false, reason: 'too-long' });
  });

  it('accepts a query exactly at the cap', () => {
    expect(approveQuery('a'.repeat(MAX_QUERY_CHARS)).ok).toBe(true);
  });

  it('measures the cap after normalisation, so padding cannot smuggle length', () => {
    // Under-cap once collapsed; over-cap if measured raw.
    const padded = `${'word '.repeat(40)}   ${'  '.repeat(60)}`;
    const result = approveQuery(padded);
    expect(result.ok).toBe(true);
    if (result.ok) expect(queryText(result.query).length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
  });

  it('rejects a passage of document text on length alone', () => {
    const passage =
      'Adenine base editors have been reported to produce substantially fewer ' +
      'double-strand breaks than nuclease-based approaches, and in our hands the ' +
      'off-target profile in primary murine hepatocytes was correspondingly lower ' +
      'across all loci examined, although the effect diminished at higher doses.';
    expect(approveQuery(passage)).toMatchObject({ ok: false, reason: 'too-long' });
  });

  it('explains a rejection in terms the user can act on', () => {
    const result = approveQuery('a'.repeat(MAX_QUERY_CHARS + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });
});
