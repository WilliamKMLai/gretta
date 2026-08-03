/**
 * Finding Ollama without making the user read the documentation.
 *
 * Word for Mac runs the task pane in WKWebView, which refuses to let an HTTPS
 * page call `http://localhost`. GRETTA ships an HTTPS proxy for exactly this,
 * but until now the user had to notice the connection failing, find the Mac
 * section of the README, and change the server URL by hand. That is a
 * documentation fix for a problem the app can simply solve: the two candidate
 * addresses are known, and trying the second when the first fails costs one
 * request.
 *
 * Only ever a *fallback*. A configured URL that works is never second-guessed,
 * and a user who has deliberately pointed GRETTA at a remote Ollama keeps that
 * setting — the probe runs when the configured address fails, not before.
 */

/** The proxy `pnpm dev:mac` and `pnpm proxy` start. */
export const MAC_PROXY_URL = 'https://localhost:11435';

/** Ollama's own default, which works everywhere except an HTTPS Mac pane. */
export const DIRECT_URL = 'http://127.0.0.1:11434';

export interface ProbeResult {
  /** A URL that answered, or null when none did. */
  url: string | null;
  /** True when this differs from what was configured, so the caller can save it. */
  changed: boolean;
}

/**
 * Tries the configured URL, then the Mac proxy.
 *
 * Deliberately tolerant about what counts as an answer: any HTTP response means
 * something is listening and speaking, which is the question being asked. A 404
 * from a misconfigured path is still evidence the address is right, and treating
 * it as failure would send the user to the proxy for the wrong reason.
 */
export async function findOllama(
  configuredUrl: string,
  probe: (url: string) => Promise<boolean>,
): Promise<ProbeResult> {
  if (await probe(configuredUrl)) return { url: configuredUrl, changed: false };

  // Only the proxy is worth a second attempt; anything else would be guessing
  // at a user's network rather than working around a known platform rule.
  if (configuredUrl !== MAC_PROXY_URL && (await probe(MAC_PROXY_URL))) {
    return { url: MAC_PROXY_URL, changed: true };
  }

  return { url: null, changed: false };
}
