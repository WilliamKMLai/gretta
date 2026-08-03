/**
 * Custom prompt templates (ARCHITECTURE.md §6, §8; ADR-005/006). Persists
 * ONLY user-created prompts; the 12 built-ins ship as code in Phase 8's
 * builtins.ts and are merged at read time by the picker. `selectedPromptId`
 * may reference either kind.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { STORAGE_KEYS, createPersistStorage } from '../../services/storage';
import type { GenerationOptions, PromptTemplate } from '../../types/domain';
import { newId } from '../../utils/id';

const generationOptionDefaultsSchema = z
  .object({
    temperature: z.number(),
    topP: z.number(),
    topK: z.number(),
    seed: z.number().nullable(),
    contextLength: z.number(),
  })
  .partial();

/** Rebuilds the partial with truly-absent keys (exactOptionalPropertyTypes). */
const toDefaults = (
  value: z.infer<typeof generationOptionDefaultsSchema>,
): Partial<GenerationOptions> => ({
  ...(value.temperature !== undefined ? { temperature: value.temperature } : {}),
  ...(value.topP !== undefined ? { topP: value.topP } : {}),
  ...(value.topK !== undefined ? { topK: value.topK } : {}),
  ...(value.seed !== undefined ? { seed: value.seed } : {}),
  ...(value.contextLength !== undefined ? { contextLength: value.contextLength } : {}),
});

const promptTemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    category: z.enum(['scientific', 'editing', 'style', 'grants', 'communication', 'custom']),
    description: z.string(),
    system: z.string(),
    user: z.string(),
    requires: z.array(z.enum(['selection', 'paragraph', 'document', 'input'])),
    builtIn: z.boolean(),
    defaults: generationOptionDefaultsSchema.optional(),
  })
  .transform((value): PromptTemplate => ({
    id: value.id,
    name: value.name,
    category: value.category,
    description: value.description,
    system: value.system,
    user: value.user,
    requires: value.requires,
    builtIn: value.builtIn,
    ...(value.defaults !== undefined ? { defaults: toDefaults(value.defaults) } : {}),
  }));

interface PersistedPrompts {
  customPrompts: PromptTemplate[];
  selectedPromptId: string | null;
}

const persistedPromptsSchema = z.object({
  customPrompts: z.array(promptTemplateSchema),
  selectedPromptId: z.string().nullable(),
}) satisfies ZodType<PersistedPrompts>;

/** Everything the user supplies when creating a custom prompt. */
export type CustomPromptInput = Omit<PromptTemplate, 'id' | 'builtIn'>;

export interface PromptsState extends PersistedPrompts {
  /** Creates a custom prompt (id assigned, builtIn forced false); returns its id. */
  addCustomPrompt: (input: CustomPromptInput) => string;
  updateCustomPrompt: (id: string, patch: Partial<CustomPromptInput>) => void;
  deleteCustomPrompt: (id: string) => void;
  /** Accepts built-in ids too; existence checks belong to the picker. */
  setSelectedPrompt: (id: string | null) => void;
}

export const usePromptsStore = create<PromptsState>()(
  persist(
    (set) => ({
      customPrompts: [],
      selectedPromptId: null,

      addCustomPrompt: (input) => {
        const prompt: PromptTemplate = { ...input, id: newId(), builtIn: false };
        set((state) => ({ customPrompts: [...state.customPrompts, prompt] }));
        return prompt.id;
      },

      updateCustomPrompt: (id, patch) => {
        set((state) => ({
          customPrompts: state.customPrompts.map((p) =>
            p.id === id ? { ...p, ...patch, id: p.id, builtIn: false } : p,
          ),
        }));
      },

      deleteCustomPrompt: (id) => {
        set((state) => ({
          customPrompts: state.customPrompts.filter((p) => p.id !== id),
          selectedPromptId: state.selectedPromptId === id ? null : state.selectedPromptId,
        }));
      },

      setSelectedPrompt: (id) => {
        set({ selectedPromptId: id });
      },
    }),
    {
      name: STORAGE_KEYS.prompts,
      storage: createPersistStorage(STORAGE_KEYS.prompts, persistedPromptsSchema),
      partialize: (state): PersistedPrompts => ({
        customPrompts: state.customPrompts,
        selectedPromptId: state.selectedPromptId,
      }),
    },
  ),
);
