/**
 * Request etiquette for third-party scholarly APIs (DECISIONS.md ADR-028).
 *
 * ADR-028 deliberately records no rate-limit numbers, on the grounds that a
 * figure copied from memory into a decision document acquires authority it has
 * not earned. It turns out not to need any: Crossref advertises the limit in
 * force on every response, in `X-Rate-Limit-Limit` and `X-Rate-Limit-Interval`,
 * and revised those limits in December 2025 — so a hardcoded constant would
 * already be stale. Reading the advertised value is both more polite and less
 * work than tracking a published number.
 *
 * The fallback pace applies only until a first response has been seen, and is
 * deliberately slower than any published limit: a client that starts cautious
 * and speeds up on evidence cannot get a user blocked, whereas one that starts
 * fast and slows down on a 429 already has.
 *
 * Pure: imports nothing, tested directly.
 */

/** Conservative pace before any server-advertised limit has been observed. */
export const FALLBACK_INTERVAL_MS = 1_000;

/** Ceiling on backoff, so a wedged source cannot stall a search indefinitely. */
export const MAX_BACKOFF_MS = 30_000;

export interface RateLimit {
  /** Requests permitted per interval. */
  limit: number;
  /** Interval length in seconds; Crossref always expresses this in seconds. */
  intervalSeconds: number;
}

/**
 * Reads the advertised limit from a response. Returns null when the headers are
 * absent or unusable, which is not an error — most sources do not advertise,
 * and the caller falls back to the conservative pace.
 */
export function parseRateLimit(headers: Headers): RateLimit | null {
  const rawLimit = headers.get('X-Rate-Limit-Limit');
  const rawInterval = headers.get('X-Rate-Limit-Interval');
  if (rawLimit === null || rawInterval === null) return null;

  const limit = Number.parseInt(rawLimit, 10);
  // The interval may arrive as a bare number or suffixed, e.g. "1s".
  const intervalSeconds = Number.parseInt(rawInterval, 10);
  if (!Number.isFinite(limit) || !Number.isFinite(intervalSeconds)) return null;
  if (limit <= 0 || intervalSeconds <= 0) return null;

  return { limit, intervalSeconds };
}

/**
 * Minimum spacing between requests implied by an advertised limit. GRETTA
 * deliberately uses the *full* interval per request rather than the permitted
 * burst: a pane doing a handful of lookups per search has no need of headroom
 * that exists for bulk consumers, and leaving it unused costs a user nothing
 * perceptible.
 */
export function minIntervalMs(rateLimit: RateLimit | null): number {
  if (rateLimit === null) return FALLBACK_INTERVAL_MS;
  return Math.ceil((rateLimit.intervalSeconds * 1_000) / rateLimit.limit);
}

/**
 * How long to wait before retrying. An explicit `Retry-After` is obeyed —
 * the server has said what it wants and guessing differently is impolite —
 * and otherwise the delay doubles per attempt from a one-second base.
 */
export function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader !== null) {
    const seconds = Number.parseInt(retryAfterHeader, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_BACKOFF_MS);
    }
  }
  const exponential = 1_000 * 2 ** Math.max(0, attempt);
  return Math.min(exponential, MAX_BACKOFF_MS);
}

/**
 * Builds a client identifier string.
 *
 * **Not sent as a `User-Agent` header.** That header is forbidden to browsers,
 * and GRETTA runs in a webview: setting it failed every request in Word while
 * passing under Node, where the live smoke tests run. Identification happens
 * through query parameters instead — `mailto` for Crossref and OpenAlex, `tool`
 * and `email` for NCBI.
 *
 * Kept because a non-browser caller of this service (a future companion-side
 * fetch, say) can and should send it, and because the assembly rules — a
 * contact address is optional PII egress, and its absence must degrade to an
 * anonymous identifier rather than a placeholder — are worth keeping in one
 * tested place.
 */
export function buildUserAgent(version: string, contactEmail: string | null): string {
  const base = `GRETTA/${version} (https://github.com/; local Word add-in)`;
  const trimmed = contactEmail?.trim() ?? '';
  return trimmed === '' ? base : `${base} mailto:${trimmed}`;
}

/**
 * Appends the polite-pool `mailto` when one is configured. Returns the URL
 * unchanged otherwise — an absent address must degrade to the public pool, not
 * to a placeholder address, which would misdirect any contact attempt.
 */
export function withContact(url: string, contactEmail: string | null): string {
  const trimmed = contactEmail?.trim() ?? '';
  if (trimmed === '') return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}mailto=${encodeURIComponent(trimmed)}`;
}
