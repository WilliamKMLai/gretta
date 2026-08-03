/**
 * Legacy-adoption tests (ADR-024). The rebrand must not cost anyone their
 * settings, prompt library, or history.
 */
import { describe, expect, it, vi } from 'vitest';
import { adoptLegacyValue } from './legacy';

function backing(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    read: (name: string): string | null => map.get(name) ?? null,
    write: (name: string, value: string): void => {
      map.set(name, value);
    },
  };
}

describe('adoptLegacyValue', () => {
  it('copies the previous build’s value across, verbatim', () => {
    const raw = '{"version":1,"data":{"temperature":0.9}}';
    const store = backing({ 'wordllama/settings': raw });
    expect(adoptLegacyValue('gretta/settings', store.read, store.write)).toBe(raw);
    expect(store.map.get('gretta/settings')).toBe(raw);
  });

  it('adopts the raw envelope so versioned migrations still run afterwards', () => {
    // A v1 payload must arrive as v1, not silently relabelled as current.
    const raw = '{"version":1,"data":{"conversations":[]}}';
    const store = backing({ 'wordllama/conversations': raw });
    adoptLegacyValue('gretta/history', store.read, store.write);
    expect(JSON.parse(store.map.get('gretta/history') ?? '{}')).toMatchObject({ version: 1 });
  });

  it('leaves the previous build’s data in place, so it keeps working', () => {
    const store = backing({ 'wordllama/prompts': 'x' });
    adoptLegacyValue('gretta/prompts', store.read, store.write);
    expect(store.map.get('wordllama/prompts')).toBe('x');
  });

  it('never overwrites data already under the current name', () => {
    const store = backing({ 'gretta/settings': 'current', 'wordllama/settings': 'old' });
    expect(adoptLegacyValue('gretta/settings', store.read, store.write)).toBeNull();
    expect(store.map.get('gretta/settings')).toBe('current');
  });

  it('does nothing for a fresh install', () => {
    const store = backing();
    expect(adoptLegacyValue('gretta/settings', store.read, store.write)).toBeNull();
    expect(store.map.size).toBe(0);
  });

  it('maps every current key to its predecessor', () => {
    for (const [current, legacy] of [
      ['gretta/settings', 'wordllama/settings'],
      ['gretta/history', 'wordllama/conversations'],
      ['gretta/prompts', 'wordllama/prompts'],
    ] as const) {
      const store = backing({ [legacy]: 'value' });
      expect(adoptLegacyValue(current, store.read, store.write)).toBe('value');
    }
  });

  it('fails soft when storage throws, rather than breaking startup', () => {
    const throwing = (): never => {
      throw new Error('storage unavailable');
    };
    expect(adoptLegacyValue('gretta/settings', throwing, vi.fn())).toBeNull();
  });
});
