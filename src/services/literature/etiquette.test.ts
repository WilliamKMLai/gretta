/**
 * Etiquette tests (DECISIONS.md ADR-028). The bias under test is "start slow,
 * speed up on evidence" — a client that starts fast and backs off after a 429
 * has already been impolite.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_INTERVAL_MS,
  MAX_BACKOFF_MS,
  abortableSleep,
  backoffMs,
  buildUserAgent,
  minIntervalMs,
  parseRateLimit,
  withContact,
} from './etiquette';

const headers = (entries: Record<string, string>): Headers => new Headers(entries);

describe('parseRateLimit', () => {
  it('reads the advertised limit and interval', () => {
    expect(
      parseRateLimit(headers({ 'X-Rate-Limit-Limit': '50', 'X-Rate-Limit-Interval': '1s' })),
    ).toEqual({ limit: 50, intervalSeconds: 1 });
  });

  it('returns null when the headers are absent', () => {
    expect(parseRateLimit(headers({}))).toBeNull();
  });

  it('returns null on nonsense rather than trusting it', () => {
    expect(
      parseRateLimit(headers({ 'X-Rate-Limit-Limit': '0', 'X-Rate-Limit-Interval': '1s' })),
    ).toBeNull();
    expect(
      parseRateLimit(headers({ 'X-Rate-Limit-Limit': 'many', 'X-Rate-Limit-Interval': '1s' })),
    ).toBeNull();
  });
});

describe('minIntervalMs', () => {
  it('falls back to the conservative pace before any limit is known', () => {
    expect(minIntervalMs(null)).toBe(FALLBACK_INTERVAL_MS);
  });

  it('spaces requests across the advertised interval rather than bursting', () => {
    expect(minIntervalMs({ limit: 50, intervalSeconds: 1 })).toBe(20);
  });

  it('speeds up when the server advertises a generous limit', () => {
    expect(minIntervalMs({ limit: 1000, intervalSeconds: 1 })).toBeLessThan(FALLBACK_INTERVAL_MS);
  });
});

describe('backoffMs', () => {
  it('obeys an explicit Retry-After', () => {
    expect(backoffMs(0, '5')).toBe(5_000);
  });

  it('doubles per attempt when the server says nothing', () => {
    expect(backoffMs(0, null)).toBe(1_000);
    expect(backoffMs(1, null)).toBe(2_000);
    expect(backoffMs(2, null)).toBe(4_000);
  });

  it('caps so a wedged source cannot stall a search indefinitely', () => {
    expect(backoffMs(20, null)).toBe(MAX_BACKOFF_MS);
    expect(backoffMs(0, '99999')).toBe(MAX_BACKOFF_MS);
  });

  it('ignores an unparseable Retry-After instead of waiting forever', () => {
    expect(backoffMs(0, 'soon')).toBe(1_000);
  });
});

describe('buildUserAgent', () => {
  it('identifies the tool even with no contact address', () => {
    const agent = buildUserAgent('1.2.3', null);
    expect(agent).toContain('GRETTA/1.2.3');
    expect(agent).not.toContain('mailto:');
  });

  it('appends the address when one is configured', () => {
    expect(buildUserAgent('1.2.3', 'sci@example.org')).toContain('mailto:sci@example.org');
  });

  it('treats a blank address as absent rather than sending an empty mailto', () => {
    expect(buildUserAgent('1.2.3', '   ')).not.toContain('mailto:');
  });
});

describe('withContact', () => {
  it('leaves the URL untouched when no address is configured', () => {
    expect(withContact('https://api.crossref.org/works?rows=5', null)).toBe(
      'https://api.crossref.org/works?rows=5',
    );
  });

  it('appends to an existing query string', () => {
    expect(withContact('https://api.crossref.org/works?rows=5', 'sci@example.org')).toBe(
      'https://api.crossref.org/works?rows=5&mailto=sci%40example.org',
    );
  });

  it('starts a query string when there is none', () => {
    expect(withContact('https://api.crossref.org/works', 'sci@example.org')).toContain('?mailto=');
  });
});

describe('abortableSleep', () => {
  it('resolves immediately for a non-positive delay', async () => {
    await expect(abortableSleep(0)).resolves.toBeUndefined();
    await expect(abortableSleep(-10)).resolves.toBeUndefined();
  });

  it('resolves once the delay elapses when not aborted', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = abortableSleep(50, controller.signal);
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(5_000, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('interrupts an in-flight backoff as soon as the signal aborts', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = abortableSleep(30_000, controller.signal);
      const expectation = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});
