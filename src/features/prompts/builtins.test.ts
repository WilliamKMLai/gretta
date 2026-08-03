import { BUILTIN_PROMPTS, CATEGORY_LABELS, CATEGORY_ORDER } from './builtins';
import { referencedVars, unknownPlaceholders } from './template';

describe('BUILTIN_PROMPTS', () => {
  it('ships exactly the 12 templates the roadmap names', () => {
    expect(BUILTIN_PROMPTS.map((p) => p.name)).toEqual([
      'Scientific Writing',
      'Grant Writing',
      'Reviewer Response',
      'Proofreading',
      'Grammar',
      'Expand',
      'Condense',
      'Nature Style',
      'Science Style',
      'NIH Specific Aims',
      'Professional Email',
      'Custom Prompt',
    ]);
  });

  it('every id is unique and builtin:-prefixed, every entry builtIn', () => {
    const ids = BUILTIN_PROMPTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const prompt of BUILTIN_PROMPTS) {
      expect(prompt.id).toMatch(/^builtin:[a-z-]+$/);
      expect(prompt.builtIn).toBe(true);
      expect(prompt.name.trim()).not.toBe('');
      expect(prompt.description.trim()).not.toBe('');
    }
  });

  it('every required var is actually referenced, and no template has typo placeholders', () => {
    for (const prompt of BUILTIN_PROMPTS) {
      const referenced = new Set(referencedVars(`${prompt.system}\n${prompt.user}`));
      for (const required of prompt.requires) {
        expect(referenced, `${prompt.name}: requires '${required}'`).toContain(required);
      }
      expect(unknownPlaceholders(prompt.system), prompt.name).toEqual([]);
      expect(unknownPlaceholders(prompt.user), prompt.name).toEqual([]);
    }
  });

  it('rewrite templates carry defaults with a bounded temperature', () => {
    for (const prompt of BUILTIN_PROMPTS) {
      if (prompt.defaults?.temperature === undefined) continue;
      expect(prompt.defaults.temperature).toBeGreaterThanOrEqual(0);
      expect(prompt.defaults.temperature).toBeLessThanOrEqual(2);
      // Phase 8 spec: defaults tune temperature only; settings own the rest.
      expect(Object.keys(prompt.defaults)).toEqual(['temperature']);
    }
    expect(
      BUILTIN_PROMPTS.find((p) => p.id === 'builtin:proofreading')?.defaults?.temperature,
    ).toBeLessThanOrEqual(0.2);
  });

  it('category metadata covers every category the templates use, in order', () => {
    for (const prompt of BUILTIN_PROMPTS) {
      expect(CATEGORY_ORDER).toContain(prompt.category);
      expect(CATEGORY_LABELS[prompt.category].trim()).not.toBe('');
    }
  });
});
