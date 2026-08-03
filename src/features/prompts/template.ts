/**
 * Prompt-template semantics (ARCHITECTURE.md §5.3 `template.ts`, §11.1;
 * ADR-007): literal substitution of `{{selection}}`, `{{paragraph}}`,
 * `{{document}}`, and `{{input}}` — no expression language, and substituted
 * values are never re-scanned (a selection containing `{{input}}` stays
 * literal text). This module also owns the `requires` rules: which context
 * variables a run must capture, which must be non-empty, and the friendly
 * typed error raised BEFORE any network call when one is missing.
 */
import type { ContextSource, PromptContextVar, PromptTemplate } from '../../types/domain';
import { OfficeError } from '../../types/errors';

/** Every placeholder name templates may reference. */
export const KNOWN_VARS: readonly PromptContextVar[] = [
  'selection',
  'paragraph',
  'document',
  'input',
];

const VAR_PATTERN = /\{\{(selection|paragraph|document|input)\}\}/g;

/** Any `{{…}}`-shaped token, for validation (typos, stray spaces). */
const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;

export type PromptVars = Partial<Record<PromptContextVar, string>>;

/** Replaces every known placeholder; unknown/missing vars become ''. */
export function applyTemplate(text: string, vars: PromptVars): string {
  return text.replace(VAR_PATTERN, (_match, name: string) => vars[name as PromptContextVar] ?? '');
}

/** The distinct context variables a template's text actually references. */
export function referencedVars(text: string): PromptContextVar[] {
  const found = new Set<PromptContextVar>();
  for (const match of text.matchAll(VAR_PATTERN)) {
    found.add(match[1] as PromptContextVar);
  }
  return [...found];
}

/**
 * `{{…}}` tokens that will NOT interpolate — unknown names, typos, or extra
 * whitespace (`{{ selection }}` is not `{{selection}}`). Returns the inner
 * text of each offending token, deduplicated, in order of first appearance.
 * The editor surfaces these as validation errors.
 */
export function unknownPlaceholders(text: string): string[] {
  const unknown = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const inner = match[1] ?? '';
    if (!(KNOWN_VARS as readonly string[]).includes(inner)) unknown.add(inner);
  }
  return [...unknown];
}

/**
 * The variables a run must capture from the document before generating:
 * template runs need `requires` ∪ every referenced placeholder; free-prompt
 * runs need `input` plus the context chip's source (§11.1).
 */
export function neededVars(
  template: PromptTemplate | null,
  contextSource: ContextSource,
): Set<PromptContextVar> {
  if (template === null) {
    const needed = new Set<PromptContextVar>(['input']);
    if (contextSource !== 'none') needed.add(contextSource);
    return needed;
  }
  return new Set<PromptContextVar>([
    ...template.requires,
    ...referencedVars(template.system),
    ...referencedVars(template.user),
  ]);
}

/** Variables that must be non-empty for this run (§11.1 "requires"). */
export function requiredVars(
  template: PromptTemplate | null,
  contextSource: ContextSource,
): PromptContextVar[] {
  if (template === null) {
    return contextSource === 'none' ? ['input'] : ['input', contextSource];
  }
  return template.requires;
}

/** The friendly, typed error for one unmet document-context requirement. */
export function requirementError(variable: Exclude<PromptContextVar, 'input'>): OfficeError {
  switch (variable) {
    case 'selection':
      return new OfficeError(
        'no-selection',
        'Select some text first — this prompt uses the selection.',
      );
    case 'paragraph':
      return new OfficeError('no-selection', 'Place the cursor in a paragraph with text first.');
    case 'document':
      return new OfficeError('no-document', 'The document is empty — add some text first.');
  }
}

/**
 * Throws the first unmet requirement as a typed `OfficeError` (§11.1: checked
 * BEFORE the machine starts, so the stream store never sees a doomed request).
 * `input` is excluded — an empty prompt box is UI-level feedback, not an
 * Office error — and callers gate it separately.
 */
export function assertRequiredContext(required: PromptContextVar[], vars: PromptVars): void {
  for (const variable of required) {
    if (variable === 'input') continue;
    if ((vars[variable] ?? '').trim() === '') throw requirementError(variable);
  }
}
