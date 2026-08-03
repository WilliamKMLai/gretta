/**
 * Abstract-to-text tests (ARCHITECTURE.md §13.1; DECISIONS.md ADR-026).
 * Abstracts are attacker-influenceable third-party text, so these lean on the
 * cases where markup could survive rather than only on tidy input.
 */
import { describe, expect, it } from 'vitest';
import { abstractToText, firstNonEmpty } from './jats';

describe('abstractToText', () => {
  it('strips JATS paragraph markup', () => {
    expect(abstractToText('<jats:p>We show that X causes Y.</jats:p>')).toBe(
      'We show that X causes Y.',
    );
  });

  it('keeps paragraph boundaries as blank lines', () => {
    expect(abstractToText('<jats:p>Background.</jats:p><jats:p>Methods.</jats:p>')).toBe(
      'Background.\n\nMethods.',
    );
  });

  it('closes up inline markup so subscripts do not gain spaces', () => {
    expect(abstractToText('H<jats:sub>2</jats:sub>O uptake')).toBe('H2O uptake');
  });

  it('decodes the entities that appear in real abstracts', () => {
    expect(abstractToText('<jats:p>37&#176;C &plusmn; 2, p &lt; 0.05</jats:p>')).toBe(
      '37°C ± 2, p < 0.05',
    );
  });

  it('decodes numeric and hex character references', () => {
    expect(abstractToText('&#945; and &#x3b2;')).toBe('α and β');
  });

  it('strips tags before decoding, so escaped markup cannot become markup', () => {
    // Decoding first would manufacture a live tag out of escaped content.
    const result = abstractToText('&lt;script&gt;alert(1)&lt;/script&gt; findings');
    expect(result).toBe('<script>alert(1)</script> findings');
    expect(result).not.toBeNull();
  });

  it('removes a genuine embedded tag entirely', () => {
    expect(abstractToText('<script>alert(1)</script>findings')).toBe('findings');
  });

  it('leaves an unknown entity alone rather than guessing', () => {
    expect(abstractToText('&unknownentity; text')).toBe('&unknownentity; text');
  });

  it('collapses whitespace without merging paragraphs', () => {
    expect(abstractToText('<jats:p>a   b</jats:p>\n\n\n<jats:p>c</jats:p>')).toBe('a b\n\nc');
  });

  it('returns null for absent, empty, or markup-only input', () => {
    expect(abstractToText(null)).toBeNull();
    expect(abstractToText(undefined)).toBeNull();
    expect(abstractToText('   ')).toBeNull();
    expect(abstractToText('<jats:p></jats:p>')).toBeNull();
  });
});

describe('firstNonEmpty', () => {
  it('returns the first entry with content', () => {
    expect(firstNonEmpty(['', '  ', 'Real title'])).toBe('Real title');
  });

  it('cleans markup out of the entry it picks', () => {
    expect(firstNonEmpty(['<jats:italic>Nature</jats:italic>'])).toBe('Nature');
  });

  it('collapses line breaks, since a title is single-line', () => {
    // Crossref deposits contain real newlines; they render as broken titles.
    expect(firstNonEmpty(['Base editing using CRISPR/Cas9 in\nDrosophila'])).toBe(
      'Base editing using CRISPR/Cas9 in Drosophila',
    );
  });

  it('returns null for an absent or empty array', () => {
    expect(firstNonEmpty(undefined)).toBeNull();
    expect(firstNonEmpty([])).toBeNull();
  });
});
