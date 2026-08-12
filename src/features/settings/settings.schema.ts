/**
 * Settings form contract (ROADMAP Phase 9; ARCHITECTURE.md §6, §10).
 *
 * The panel is a *validated buffer* over the store (ADR-016): React Hook Form
 * owns what you're typing, the store owns what's committed. Each field is its
 * own schema so a half-typed URL blocks only the URL — changing temperature
 * still applies immediately, which is what keeps Phase 6's hot-apply behaviour
 * (URL edits re-drive the health/model queries) while satisfying Phase 9's
 * "invalid input can't be saved".
 *
 * Form values are not `AppSettings`: free-text controls hold strings, so seed
 * is `''`-for-random and defaultModel is `''`-for-none. `toPatch` does that
 * conversion at the commit boundary and nowhere else.
 */
import { z } from 'zod';
import type { AppSettings } from '../../types/domain';

/** Bounds are also the SpinButton/Slider min/max — one source of truth. */
export const LIMITS = {
  temperature: { min: 0, max: 2, step: 0.1 },
  topP: { min: 0, max: 1, step: 0.05 },
  topK: { min: 0, max: 200, step: 1 },
  contextLength: { min: 512, max: 131072, step: 512 },
} as const;

const urlField = z
  .string()
  .trim()
  .min(1, 'Enter the Ollama server URL.')
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Enter a full URL including http:// or https://');

const contactEmailField = z
  .string()
  .trim()
  .refine(
    (value) => value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value),
    'Enter a valid email address, or leave blank to use the public API pool.',
  );

const seedField = z
  .string()
  .trim()
  .refine(
    (value) => value === '' || /^-?\d+$/.test(value),
    'Seed must be a whole number, or blank for random.',
  );

/**
 * Per-field schemas. The form resolver is `z.object(FIELD_SCHEMAS)`, so the
 * field-level and form-level rules can never drift apart.
 */
export const FIELD_SCHEMAS = {
  ollamaUrl: urlField,
  defaultModel: z.string(),
  theme: z.enum(['light', 'dark', 'system', 'office']),
  streaming: z.boolean(),
  autoCopy: z.boolean(),
  autoInsert: z.boolean(),
  temperature: z
    .number()
    .min(LIMITS.temperature.min, 'Temperature is 0–2.')
    .max(LIMITS.temperature.max, 'Temperature is 0–2.'),
  topP: z.number().min(LIMITS.topP.min, 'Top P is 0–1.').max(LIMITS.topP.max, 'Top P is 0–1.'),
  topK: z
    .number()
    .int('Top K must be a whole number.')
    .min(LIMITS.topK.min, 'Top K cannot be negative.')
    .max(LIMITS.topK.max, `Top K is ${String(LIMITS.topK.min)}–${String(LIMITS.topK.max)}.`),
  seed: seedField,
  responseReservePct: z
    .number()
    .min(5, 'Reserve at least 5%.')
    .max(60, 'Reserving more than 60% leaves too little room for context.'),
  kbEnabled: z.boolean(),
  defaultEmbeddingModel: z.string(),
  litEnabled: z.boolean(),
  litSources: z.object({
    pubmed: z.boolean(),
    biorxiv: z.boolean(),
    medrxiv: z.boolean(),
    openalex: z.boolean(),
  }),
  litVerification: z.boolean(),
  // Blank means "use the general model"; stored as null, like defaultModel.
  litDraftModel: z.string(),
  // Same convention (ADR-034): blank is "use the general model", stored as null.
  visionModel: z.string(),
  // Optional by design (ADR-028): a blank address degrades to the public pool.
  // A malformed one is rejected rather than sent, since a wrong address in a
  // User-Agent misdirects any contact attempt an API operator makes.
  litContactEmail: contactEmailField,
  litOpenAlexKey: z.string().trim(),
  litResultsPerSource: z
    .number()
    .int('Results per source must be a whole number.')
    .min(5, 'Fewer than five candidates leaves ranking nothing to work with.')
    .max(100, 'Sources cap a single request at 100 records.'),
  litMinVenueCitedness: z
    .number()
    .min(0, 'A citation threshold cannot be negative.')
    .max(50, 'Above this, the caution would fire on nearly every journal.'),
  contextLength: z
    .number()
    .int('Context length must be a whole number.')
    .min(
      LIMITS.contextLength.min,
      `Context length is at least ${String(LIMITS.contextLength.min)}.`,
    )
    .max(LIMITS.contextLength.max, 'Context length is too large for any local model.'),
} as const;

export const settingsFormSchema = z.object(FIELD_SCHEMAS);

export type SettingsFormValues = z.infer<typeof settingsFormSchema>;
export type SettingsFieldName = keyof SettingsFormValues;

/** Store → form: nullable persisted values become the controls' empty strings. */
export function toFormValues(settings: AppSettings): SettingsFormValues {
  return {
    ollamaUrl: settings.ollamaUrl,
    defaultModel: settings.defaultModel ?? '',
    theme: settings.theme,
    streaming: settings.streaming,
    autoCopy: settings.autoCopy,
    autoInsert: settings.autoInsert,
    temperature: settings.temperature,
    topP: settings.topP,
    topK: settings.topK,
    seed: settings.seed === null ? '' : String(settings.seed),
    responseReservePct: settings.responseReservePct,
    kbEnabled: settings.kbEnabled,
    defaultEmbeddingModel: settings.defaultEmbeddingModel,
    visionModel: settings.visionModel ?? '',
    litEnabled: settings.litEnabled,
    litSources: settings.litSources,
    litVerification: settings.litVerification,
    litDraftModel: settings.litDraftModel ?? '',
    litContactEmail: settings.litContactEmail,
    litOpenAlexKey: settings.litOpenAlexKey,
    litResultsPerSource: settings.litResultsPerSource,
    litMinVenueCitedness: settings.litMinVenueCitedness,
    contextLength: settings.contextLength,
  };
}

/**
 * Form → store for ONE field, or null when that field is currently invalid.
 * The caller commits the patch; a null means "keep typing, nothing saved".
 */
export function toPatch(
  name: SettingsFieldName,
  value: SettingsFormValues[SettingsFieldName],
): Partial<AppSettings> | null {
  const parsed = FIELD_SCHEMAS[name].safeParse(value);
  if (!parsed.success) return null;
  switch (name) {
    case 'ollamaUrl':
      return { ollamaUrl: (parsed.data as string).trim() };
    case 'defaultModel': {
      const model = parsed.data as string;
      return { defaultModel: model === '' ? null : model };
    }
    case 'litDraftModel': {
      const model = (parsed.data as string).trim();
      return { litDraftModel: model === '' ? null : model };
    }
    case 'visionModel': {
      const model = (parsed.data as string).trim();
      return { visionModel: model === '' ? null : model };
    }
    case 'litOpenAlexKey':
      return { litOpenAlexKey: (parsed.data as string).trim() };
    case 'litContactEmail':
      return { litContactEmail: (parsed.data as string).trim() };
    case 'seed': {
      const seed = (parsed.data as string).trim();
      return { seed: seed === '' ? null : Number(seed) };
    }
    default:
      return { [name]: parsed.data };
  }
}
