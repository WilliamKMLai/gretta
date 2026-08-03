/**
 * Joins a base URL and a path without producing double or missing slashes.
 * Used by services/ollama to build endpoint URLs from the user-configured
 * base URL, which may or may not carry a trailing slash.
 */
export function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${normalizedPath}`;
}
