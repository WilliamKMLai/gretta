/**
 * The currently selected template — built-in or custom — or null for the
 * free-form prompt. Ids that resolve to nothing (a deleted custom restored
 * from an old persistence payload) fall back to the free prompt rather than
 * crashing or pinning the UI to a ghost.
 */
import type { PromptTemplate } from '../../types/domain';
import { BUILTIN_PROMPTS } from './builtins';
import { usePromptsStore } from './prompts.store';

/** Resolves an id against built-ins ∪ the given customs; null when absent. */
export function findPrompt(
  id: string | null,
  customPrompts: readonly PromptTemplate[],
): PromptTemplate | null {
  if (id === null) return null;
  return (
    BUILTIN_PROMPTS.find((prompt) => prompt.id === id) ??
    customPrompts.find((prompt) => prompt.id === id) ??
    null
  );
}

export function useSelectedPrompt(): PromptTemplate | null {
  const customPrompts = usePromptsStore((state) => state.customPrompts);
  const selectedId = usePromptsStore((state) => state.selectedPromptId);
  return findPrompt(selectedId, customPrompts);
}
