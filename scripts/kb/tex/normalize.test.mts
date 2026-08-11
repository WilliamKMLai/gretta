import { describe, expect, it } from 'vitest';
import {
  normalizeAccents,
  normalizeQuotes,
  normalizeDashes,
  normalizeTilde,
  normalizeSpacingCommands,
  collapseWhitespace,
} from './normalize.mts';

describe('normalizeAccents', () => {
  it('resolves the five documented braced forms', () => {
    expect(normalizeAccents('Bj\\"{o}rk')).toBe('Björk');
    expect(normalizeAccents('na\\"{\\i}ve')).toBe('naïve');
    expect(normalizeAccents('Erd\\H{o}s')).toBe('Erdős');
    expect(normalizeAccents("caf\\'{e}")).toBe('café');
    expect(normalizeAccents("Sant\\'{e}")).toBe('Santé');
  });

  it('resolves the bare (unbraced) form for symbol accents', () => {
    expect(normalizeAccents("caf\\'e")).toBe('café');
    expect(normalizeAccents('Bj\\"ork')).toBe('Björk');
  });

  it('does not treat a longer command starting with a letter-accent name as an accent', () => {
    // \Huge is a font-size command, not \H applied to "u" — a bare-form
    // match here would silently corrupt it.
    expect(normalizeAccents('\\Huge Text')).toBe('\\Huge Text');
  });

  it('leaves an accent command with no recognized base letter untouched', () => {
    expect(normalizeAccents('\\H{q}')).toBe('\\H{q}');
  });

  it('does not alter a bare, non-backslash-prefixed tilde', () => {
    expect(normalizeAccents('a~b')).toBe('a~b');
  });
});

describe('normalizeQuotes', () => {
  it('converts doubled TeX quotes before singles', () => {
    expect(normalizeQuotes("``double'' and `single'")).toBe('“double” and ‘single’');
  });
});

describe('normalizeDashes', () => {
  it('converts a triple hyphen to an em dash, not en dash plus hyphen', () => {
    expect(normalizeDashes('a---b')).toBe('a—b');
  });

  it('converts a double hyphen to an en dash', () => {
    expect(normalizeDashes('40--60')).toBe('40–60');
  });
});

describe('normalizeSpacingCommands', () => {
  it('turns \\, \\; \\! and explicit \\<space> into a plain space', () => {
    expect(normalizeSpacingCommands('400\\,token')).toBe('400 token');
    expect(normalizeSpacingCommands('a\\;b')).toBe('a b');
    expect(normalizeSpacingCommands('k_1\\!\\left(1-b\\right)')).toBe('k_1 \\left(1-b\\right)');
    expect(normalizeSpacingCommands('e.g.\\ this')).toBe('e.g. this');
  });

  it('leaves an unrelated escaped character (e.g. \\$) untouched', () => {
    expect(normalizeSpacingCommands('\\$40')).toBe('\\$40');
  });
});

describe('normalizeTilde', () => {
  it('replaces every remaining bare tilde with a space', () => {
    expect(normalizeTilde('Fig.~1 and Sec.~2')).toBe('Fig. 1 and Sec. 2');
  });
});

describe('collapseWhitespace', () => {
  it('collapses runs of spaces/tabs and 3+ newlines, and trims', () => {
    expect(collapseWhitespace('  a   b\n\n\n\nc  ')).toBe('a b\n\nc');
  });
});
