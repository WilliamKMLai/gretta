import { DEFAULT_SETTINGS } from './settings.store';
import { FIELD_SCHEMAS, LIMITS, toFormValues, toPatch } from './settings.schema';

describe('toFormValues', () => {
  it('maps nullable settings onto the controls empty strings', () => {
    expect(toFormValues({ ...DEFAULT_SETTINGS, seed: null, defaultModel: null })).toMatchObject({
      seed: '',
      defaultModel: '',
    });
  });

  it('stringifies a set seed and passes the model through', () => {
    expect(
      toFormValues({ ...DEFAULT_SETTINGS, seed: -7, defaultModel: 'llama3.1:8b' }),
    ).toMatchObject({ seed: '-7', defaultModel: 'llama3.1:8b' });
  });
});

describe('toPatch', () => {
  it('trims a valid URL', () => {
    expect(toPatch('ollamaUrl', '  https://localhost:11435  ')).toEqual({
      ollamaUrl: 'https://localhost:11435',
    });
  });

  it('rejects URLs without a scheme, and empty ones', () => {
    expect(toPatch('ollamaUrl', 'localhost:11434')).toBeNull();
    expect(toPatch('ollamaUrl', '')).toBeNull();
  });

  it('rejects a non-http scheme', () => {
    expect(toPatch('ollamaUrl', 'ftp://localhost:11434')).toBeNull();
  });

  it('maps the empty model choice back to null', () => {
    expect(toPatch('defaultModel', '')).toEqual({ defaultModel: null });
    expect(toPatch('defaultModel', 'mistral:7b')).toEqual({ defaultModel: 'mistral:7b' });
  });

  it('parses seeds, including negatives, and rejects non-integers', () => {
    expect(toPatch('seed', '')).toEqual({ seed: null });
    expect(toPatch('seed', '42')).toEqual({ seed: 42 });
    expect(toPatch('seed', '-7')).toEqual({ seed: -7 });
    expect(toPatch('seed', '12.5')).toBeNull();
    expect(toPatch('seed', 'abc')).toBeNull();
  });

  it('enforces the sampling ranges', () => {
    expect(toPatch('temperature', 2.5)).toBeNull();
    expect(toPatch('temperature', -0.1)).toBeNull();
    expect(toPatch('temperature', 2)).toEqual({ temperature: 2 });
    expect(toPatch('topP', 1.2)).toBeNull();
    expect(toPatch('topP', 0.9)).toEqual({ topP: 0.9 });
  });

  it('requires whole numbers for topK and context length', () => {
    expect(toPatch('topK', 40.5)).toBeNull();
    expect(toPatch('topK', -1)).toBeNull();
    expect(toPatch('contextLength', 100)).toBeNull();
    expect(toPatch('contextLength', 4096)).toEqual({ contextLength: 4096 });
  });

  it('rejects an unknown theme', () => {
    expect(toPatch('theme', 'neon')).toBeNull();
    expect(toPatch('theme', 'office')).toEqual({ theme: 'office' });
  });
});

describe('LIMITS', () => {
  it('the control bounds and the schema agree', () => {
    expect(FIELD_SCHEMAS.temperature.safeParse(LIMITS.temperature.max).success).toBe(true);
    expect(FIELD_SCHEMAS.topP.safeParse(LIMITS.topP.max).success).toBe(true);
    expect(FIELD_SCHEMAS.topK.safeParse(LIMITS.topK.max).success).toBe(true);
    expect(FIELD_SCHEMAS.contextLength.safeParse(LIMITS.contextLength.min).success).toBe(true);
  });

  it('every default settings value passes its own field schema', () => {
    const values = toFormValues(DEFAULT_SETTINGS);
    for (const [name, schema] of Object.entries(FIELD_SCHEMAS)) {
      const result = schema.safeParse(values[name as keyof typeof values]);
      expect(result.success, `${name} default`).toBe(true);
    }
  });
});

describe('literature settings (ADR-028)', () => {
  it('ships every source off, so nothing can leave the machine unasked', () => {
    expect(DEFAULT_SETTINGS.litEnabled).toBe(false);
    expect(Object.values(DEFAULT_SETTINGS.litSources).some(Boolean)).toBe(false);
    // Recommended, but recommendation is not consent.
    expect(DEFAULT_SETTINGS.litVerification).toBe(false);
  });

  it('keeps Crossref out of the search sources, since it only verifies', () => {
    // Demoted on evidence (ADR-031): no relevance model, and OpenAlex already
    // ingests its metadata, so searching both diluted the pool.
    expect(DEFAULT_SETTINGS.litSources).not.toHaveProperty('crossref');
    expect(DEFAULT_SETTINGS.litSources).toHaveProperty('openalex');
  });

  it('inherits the general model when no drafting model is chosen', () => {
    expect(DEFAULT_SETTINGS.litDraftModel).toBeNull();
    expect(toPatch('litDraftModel', '')).toEqual({ litDraftModel: null });
    expect(toPatch('litDraftModel', '  qwen2.5:3b ')).toEqual({ litDraftModel: 'qwen2.5:3b' });
  });

  it('presents an inherited drafting model as an empty control', () => {
    expect(toFormValues({ ...DEFAULT_SETTINGS, litDraftModel: null })).toMatchObject({
      litDraftModel: '',
    });
  });

  it('accepts a blank contact address, which degrades to the public pool', () => {
    expect(toPatch('litContactEmail', '')).toEqual({ litContactEmail: '' });
  });

  it('rejects a malformed address rather than sending it', () => {
    // A wrong address in a User-Agent misdirects any contact an operator attempts.
    expect(toPatch('litContactEmail', 'not-an-address')).toBeNull();
  });

  it('trims a valid address at the commit boundary', () => {
    expect(toPatch('litContactEmail', '  sci@example.org ')).toEqual({
      litContactEmail: 'sci@example.org',
    });
  });

  it('bounds the candidate pool to what sources will actually return', () => {
    expect(toPatch('litResultsPerSource', 101)).toBeNull();
    expect(toPatch('litResultsPerSource', 50)).toEqual({ litResultsPerSource: 50 });
  });

  it('carries provisional ranking thresholds as settings, not constants', () => {
    // ADR-029 flagged these as guessed. Exposing them lets a beta tester tune
    // them against real result sets rather than filing a bug about the default.
    expect(DEFAULT_SETTINGS.litMinVenueCitedness).toBe(0.2);
    expect(toPatch('litMinVenueCitedness', 1.5)).toEqual({ litMinVenueCitedness: 1.5 });
    expect(toPatch('litMinVenueCitedness', -1)).toBeNull();
  });
});
