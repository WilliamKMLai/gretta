/**
 * Query-drafting tests (DECISIONS.md ADR-028). Written around the ways a small
 * local model ignores instructions, since that is the realistic input.
 */
import { describe, expect, it } from 'vitest';
import { DRAFT_TARGET_CHARS, buildDraftPrompt, extractDraftedQuery } from './draftQuery';

describe('extractDraftedQuery', () => {
  it('takes a clean single-line query as-is', () => {
    expect(extractDraftedQuery('base editing hepatocyte off-target')).toBe(
      'base editing hepatocyte off-target',
    );
  });

  it('strips a label the model added despite being told not to', () => {
    expect(extractDraftedQuery('Search query: base editing')).toBe('base editing');
    expect(extractDraftedQuery('Query — base editing')).toBe('base editing');
  });

  it('keeps a comma-separated list of quoted phrases intact', () => {
    // This produced `Precision medicine", "target tractability` — unbalanced
    // quotes that no search API can parse.
    expect(extractDraftedQuery('"Precision medicine", "target tractability"')).toBe(
      '"Precision medicine" "target tractability"',
    );
  });

  it('drops quotes around a single word, which needs none', () => {
    expect(extractDraftedQuery('"AlphaFold3", "RFdiffusion"')).toBe('AlphaFold3 RFdiffusion');
  });

  it('mixes quoted phrases and bare terms without unbalancing anything', () => {
    const result = extractDraftedQuery('"base editing", hepatocyte');
    expect(result.match(/"/gu)).toHaveLength(2);
  });

  it('strips surrounding quotes, including curly ones', () => {
    expect(extractDraftedQuery('"base editing"')).toBe('"base editing"');
    expect(extractDraftedQuery('\u201Cbase editing\u201D')).toBe('"base editing"');
  });

  it('takes the first option when the model offers a list', () => {
    expect(extractDraftedQuery('1. base editing\n2. prime editing')).toBe('base editing');
  });

  it('skips a leading blank line or preamble newline', () => {
    expect(extractDraftedQuery('\n\nbase editing')).toBe('base editing');
  });

  it('truncates at a word boundary rather than mid-word', () => {
    const long = `${'hepatocyte '.repeat(40)}end`;
    const result = extractDraftedQuery(long);
    expect(result.length).toBeLessThanOrEqual(DRAFT_TARGET_CHARS);
    expect(result.endsWith('hepatocyte')).toBe(true);
  });

  it('returns an empty string when the model returned nothing usable', () => {
    // The panel then shows an empty field the user can type into, which is a
    // better failure than an error with no path forward.
    expect(extractDraftedQuery('')).toBe('');
    expect(extractDraftedQuery('   \n  ')).toBe('');
  });

  it('collapses internal whitespace so the field shows what will be sent', () => {
    expect(extractDraftedQuery('base    editing')).toBe('base editing');
  });
});

describe('buildDraftPrompt', () => {
  it('includes the passage and asks for a query', () => {
    const prompt = buildDraftPrompt('Adenine base editors reduce double-strand breaks.');
    expect(prompt).toContain('Adenine base editors');
    expect(prompt).toContain('Search query:');
  });
});
