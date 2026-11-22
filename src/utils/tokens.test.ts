/** Prompt-size estimation (ADR-025). */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHARS_PER_TOKEN,
  charsForTokens,
  estimateTokens,
  observeRatio,
  trimMiddle,
} from './tokens';

describe('estimateTokens', () => {
  it('is zero for empty text and at least one otherwise', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
  });

  it('scales with length', () => {
    expect(estimateTokens('x'.repeat(360))).toBe(100);
  });

  it('over-estimates rather than under-estimates by default', () => {
    // A conservative ratio must predict MORE tokens than the common ~4.0 rule.
    expect(DEFAULT_CHARS_PER_TOKEN).toBeLessThan(4);
    expect(estimateTokens('x'.repeat(400))).toBeGreaterThan(100);
  });

  it('falls back when handed a nonsense ratio', () => {
    expect(estimateTokens('x'.repeat(360), 0)).toBe(100);
    expect(estimateTokens('x'.repeat(360), -5)).toBe(100);
  });
});

describe('charsForTokens', () => {
  it('inverts the estimate', () => {
    expect(charsForTokens(100, 4)).toBe(400);
    expect(charsForTokens(0)).toBe(0);
    expect(charsForTokens(-1)).toBe(0);
  });
});

describe('observeRatio', () => {
  it('moves toward a measured ratio without jumping to it', () => {
    const next = observeRatio(3.6, 4000, 1000); // observed 4.0
    expect(next).toBeGreaterThan(3.6);
    expect(next).toBeLessThan(4.0);
  });

  it('converges on the truth over repeated observations', () => {
    let ratio = 3.6;
    for (let i = 0; i < 25; i += 1) ratio = observeRatio(ratio, 4000, 1000);
    expect(ratio).toBeCloseTo(4.0, 1);
  });

  it('rejects a sample too small to be meaningful', () => {
    expect(observeRatio(3.6, 40, 10)).toBe(3.6);
  });

  it('rejects a cached-prompt sample that would corrupt the ratio', () => {
    // Ollama reuses cached prefixes, reporting far fewer tokens than the
    // prompt really contained — an implausibly high chars-per-token.
    expect(observeRatio(3.6, 100_000, 50)).toBe(3.6);
  });

  it('rejects an implausibly low ratio', () => {
    expect(observeRatio(3.6, 100, 100)).toBe(3.6);
  });

  it('ignores a missing count', () => {
    expect(observeRatio(3.6, 4000, 0)).toBe(3.6);
  });
});

describe('trimMiddle', () => {
  it('leaves text that already fits', () => {
    expect(trimMiddle('short', 100)).toBe('short');
  });

  it('keeps the beginning and the end, and says what it dropped', () => {
    const text = `START${'x'.repeat(5000)}END`;
    const trimmed = trimMiddle(text, 500);
    expect(trimmed.startsWith('START')).toBe(true);
    expect(trimmed.endsWith('END')).toBe(true);
    expect(trimmed).toMatch(/characters omitted/);
    expect(trimmed.length).toBeLessThanOrEqual(500);
  });

  it('returns nothing for a zero budget', () => {
    expect(trimMiddle('anything', 0)).toBe('');
    expect(trimMiddle('anything', -5)).toBe('');
  });

  it('reports the exact number of characters omitted rather than text.length - maxChars', () => {
    const text = 'A'.repeat(1000);
    const trimmed = trimMiddle(text, 200);
    const match = /\[… ([\d,]+) characters omitted/u.exec(trimmed);
    expect(match).not.toBeNull();
    const reportedOmitted = Number((match?.[1] ?? '0').replace(/,/gu, ''));
    const kept = Array.from(trimmed).filter((ch) => ch === 'A').length;
    expect(reportedOmitted).toBe(text.length - kept);
    expect(trimmed.length).toBeLessThanOrEqual(200);
  });

  it('never exceeds maxChars even when the budget is smaller than the omission marker', () => {
    const text = 'A'.repeat(500);
    for (const budget of [1, 2, 10, 20, 50, 55, 58, 61, 62, 65]) {
      const trimmed = trimMiddle(text, budget);
      expect(trimmed.length).toBeLessThanOrEqual(budget);
      expect(trimmed.length).toBeGreaterThan(0);
    }
  });
});
