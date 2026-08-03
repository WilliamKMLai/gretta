import type { PromptTemplate } from '../../types/domain';
import { BUILTIN_PROMPTS } from './builtins';
import { findPrompt } from './useSelectedPrompt';

const custom: PromptTemplate = {
  id: 'c1',
  name: 'Mine',
  category: 'custom',
  description: '',
  system: '',
  user: 'do {{input}}',
  requires: ['input'],
  builtIn: false,
};

describe('findPrompt', () => {
  it('resolves built-in ids', () => {
    expect(findPrompt('builtin:proofreading', [])).toBe(
      BUILTIN_PROMPTS.find((p) => p.id === 'builtin:proofreading'),
    );
  });

  it('resolves custom ids', () => {
    expect(findPrompt('c1', [custom])).toBe(custom);
  });

  it('null and dangling ids resolve to the free prompt', () => {
    expect(findPrompt(null, [custom])).toBeNull();
    expect(findPrompt('gone', [custom])).toBeNull();
  });
});
