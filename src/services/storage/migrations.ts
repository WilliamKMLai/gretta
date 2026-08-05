/**
 * Persisted-payload migrations (ADR-006; ARCHITECTURE.md §7.3).
 *
 * Each function upgrades a payload FROM version n TO n + 1. They receive
 * `unknown` straight off disk — a payload written by an older build, possibly
 * hand-edited — so they validate defensively and drop what they cannot read
 * rather than throwing: a failed migration costs the user their history, while
 * a skipped entry costs one row.
 *
 * These live in the services layer (not the owning feature) because
 * `storage.service.ts` cannot import features (§5.2).
 */

/** Defaults that shipped before ADR-022, used to detect an untouched setting. */
const PREVIOUS_DEFAULTS = {
  contextLength: 2048,
  kbDefaultEmbeddingModel: 'nomic-embed-text',
} as const;

/**
 * v1 → v2 settings: adopt the corrected defaults, but ONLY where the stored
 * value is still the old default (ADR-022). A value the user deliberately
 * chose is theirs; a migration that overwrites it would be a bug, not a fix.
 */
export function settingsV1ToV2(data: unknown): unknown {
  if (!isRecord(data)) return data;
  const next = { ...data };
  if (next.contextLength === PREVIOUS_DEFAULTS.contextLength) next.contextLength = 4096;
  if (next.kbDefaultEmbeddingModel === PREVIOUS_DEFAULTS.kbDefaultEmbeddingModel) {
    next.kbDefaultEmbeddingModel = 'nomic-embed-text:latest';
  }
  return next;
}

/**
 * v2 → v3 settings: `kbDefaultEmbeddingModel` becomes `defaultEmbeddingModel`.
 *
 * The setting was named for the knowledge base because that was the only thing
 * that embedded anything. ADR-030 gives the pane its own `embed()` for
 * literature re-ranking, so one key now serves two features and a
 * knowledge-base-prefixed name misdescribes it.
 *
 * The rename is worth a migration rather than a fallback read: leaving both
 * names alive means every future reader has to know which one wins, and that
 * ambiguity outlives the convenience. A stored value is carried across intact —
 * a user's chosen model is theirs, and this migration is about where it lives,
 * not what it is.
 */
export function settingsV2ToV3(data: unknown): unknown {
  if (!isRecord(data)) return data;
  const { kbDefaultEmbeddingModel, ...rest } = data;
  if (typeof kbDefaultEmbeddingModel !== 'string') return rest;
  return { ...rest, defaultEmbeddingModel: kbDefaultEmbeddingModel };
}

/**
 * v3 → v4 settings: adds `litCitationImpactWeight`, exposing what was a
 * hardcoded constant in the citation-impact ranking nudge (ADR-029's
 * amendment). A v3 payload predates the field entirely, so there is no
 * "user's value" to preserve here — every v3 install gets the same default a
 * fresh install would.
 */
export function settingsV3ToV4(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if (typeof data.litCitationImpactWeight === 'number') return data;
  return { ...data, litCitationImpactWeight: 0.25 };
}

/** The v4 default, which v5 treats as "never touched". */
const V4_CITATION_IMPACT_DEFAULT = 0.25;
/** ADR-029's fifth amendment; must track `DEFAULT_SETTINGS`. */
const V5_CITATION_IMPACT_DEFAULT = 0.6;

/**
 * v4 → v5 settings: rescales `litCitationImpactWeight`, because the quantity it
 * weights changed (ADR-029, fifth amendment). In v4 it multiplied
 * `citedByPercentileYear`, which OpenAlex leaves null for most preprints, so
 * the term it scaled was frequently zero; in v5 it multiplies a log-scaled raw
 * citation count that is present whenever OpenAlex is. A number tuned against
 * the old scale does not mean the same thing on the new one.
 *
 * Only a stored `0.25` is replaced — the v4 default, and therefore
 * indistinguishable from a user who never opened the Advanced panel. Anything
 * else is left alone: we cannot rescale a deliberate choice without guessing at
 * the intent behind it, and a user who set 0 to turn the boost off entirely
 * must not have it switched back on by an upgrade.
 */
export function settingsV4ToV5(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if (data.litCitationImpactWeight !== V4_CITATION_IMPACT_DEFAULT) return data;
  return { ...data, litCitationImpactWeight: V5_CITATION_IMPACT_DEFAULT };
}

/** Shape of a v1 `gretta/history` payload, as far as we rely on it. */
interface LegacyMessage {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  createdAt?: unknown;
  model?: unknown;
  stats?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * v1 → v2: conversation threads become flat generation records (ADR-021).
 *
 * Each user message is paired with the assistant reply that follows it, which
 * is exactly how single-shot runs were stored inside a thread. An assistant
 * message with no preceding user message still becomes a record (with an empty
 * prompt) so no generated text is silently discarded. Ordering is normalised to
 * newest-first, matching the new store.
 */
export function conversationsV1ToHistoryV2(data: unknown): unknown {
  if (!isRecord(data) || !Array.isArray(data.conversations)) return { records: [] };

  const records: Record<string, unknown>[] = [];
  for (const conversation of data.conversations) {
    if (!isRecord(conversation) || !Array.isArray(conversation.messages)) continue;
    const messages = conversation.messages.filter(isRecord) as LegacyMessage[];

    let pendingPrompt: string | null = null;
    let promptAt: string | null = null;

    const flush = (assistant: LegacyMessage | null, at: string): void => {
      if (pendingPrompt === null && assistant === null) return;
      const stats = isRecord(assistant?.stats) ? assistant.stats : undefined;
      records.push({
        id: str(assistant?.id, `${str(conversation.id, 'conversation')}-${String(records.length)}`),
        createdAt: at,
        prompt: pendingPrompt ?? '',
        response: str(assistant?.content),
        model: str(assistant?.model, 'unknown'),
        // A stored reply is a finished one; anything else was never persisted.
        outcome: 'completed',
        ...(stats === undefined ? {} : { stats }),
      });
      pendingPrompt = null;
      promptAt = null;
    };

    for (const message of messages) {
      const at = str(message.createdAt, str(conversation.updatedAt, new Date().toISOString()));
      if (message.role === 'user') {
        // Two prompts in a row: the first never got a reply, but it happened.
        if (pendingPrompt !== null) flush(null, promptAt ?? at);
        pendingPrompt = str(message.content);
        promptAt = at;
      } else if (message.role === 'assistant') {
        flush(message, promptAt ?? at);
      }
      // system messages were never persisted per-turn; nothing to carry over.
    }
    if (pendingPrompt !== null) flush(null, promptAt ?? str(conversation.updatedAt));
  }

  records.sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)));
  return { records };
}
