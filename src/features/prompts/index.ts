/** Public API of the prompts feature. */
export { usePromptsStore, type CustomPromptInput, type PromptsState } from './prompts.store';
export { BUILTIN_PROMPTS, CATEGORY_LABELS, CATEGORY_ORDER } from './builtins';
export { PromptPicker } from './components/PromptPicker';
export { findPrompt, useSelectedPrompt } from './useSelectedPrompt';
export {
  KNOWN_VARS,
  applyTemplate,
  assertRequiredContext,
  neededVars,
  referencedVars,
  requiredVars,
  requirementError,
  unknownPlaceholders,
  type PromptVars,
} from './template';
