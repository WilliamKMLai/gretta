/**
 * Recognising embedding models (ADR-026).
 *
 * Ollama's `/api/tags` reports names and sizes but not capabilities, and
 * probing `/api/show` per model would mean one request per installed model
 * every time the panel opens. Names are matched instead.
 *
 * The list can only ever be incomplete, so this filters a *suggestion* — the
 * caller keeps the user's current choice available even when it does not match,
 * because being locked out of an unusual but valid model is worse than showing
 * one that will not work.
 */

/** Substrings shared by the embedding models Ollama publishes. */
const EMBEDDING_HINTS = [
  'embed',
  'bge',
  'gte-',
  'e5-',
  'minilm',
  'nomic',
  'mxbai',
  'snowflake-arctic',
] as const;

export function looksLikeEmbeddingModel(name: string): boolean {
  const lower = name.toLowerCase();
  return EMBEDDING_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Narrows an installed-model list to likely embedding models, falling back to
 * the full list when nothing matches — an empty picker is never the right answer.
 */
export function filterEmbeddingModels(models: readonly string[]): string[] {
  const matches = models.filter(looksLikeEmbeddingModel);
  return matches.length > 0 ? matches : [...models];
}

/**
 * Explains why a typed folder path will not work, or null when it looks usable.
 * The pane cannot open a picker, so catching an obvious mistake here saves a
 * round-trip through the companion and an unexplained empty index.
 */
export function describeFolderProblem(path: string): string | null {
  const value = path.trim();
  if (value === '') return 'Paste the absolute path to a folder on this computer.';
  if (/[\n\t]/u.test(value)) return 'That path contains a line break — paste it as a single line.';
  if (value.startsWith('~')) return 'Expand ~ to your full home folder path.';
  const absolute =
    value.startsWith('/') || /^[a-zA-Z]:[\\/]/u.test(value) || value.startsWith('\\\\');
  if (!absolute) {
    return 'Use a full path (starting with / on Mac, or C:\\ on Windows), not a relative one.';
  }
  return null;
}
