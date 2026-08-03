import { STORAGE_KEYS } from '../../services/storage';
import { usePromptsStore } from './prompts.store';
import type { CustomPromptInput } from './prompts.store';

const initial = usePromptsStore.getState();

beforeEach(() => {
  window.localStorage.clear();
  usePromptsStore.setState(initial, true);
});

const input = (overrides: Partial<CustomPromptInput> = {}): CustomPromptInput => ({
  name: 'Tighten prose',
  category: 'custom',
  description: 'Make it terse',
  system: 'You are a ruthless editor.',
  user: 'Tighten: {{selection}}',
  requires: ['selection'],
  defaults: { temperature: 0.2 },
  ...overrides,
});

describe('usePromptsStore', () => {
  it('addCustomPrompt assigns an id and forces builtIn=false', () => {
    const id = usePromptsStore.getState().addCustomPrompt(input());
    const prompt = usePromptsStore.getState().customPrompts[0];
    expect(prompt?.id).toBe(id);
    expect(prompt?.builtIn).toBe(false);
    expect(prompt?.category).toBe('custom');
  });

  it('updateCustomPrompt patches fields but keeps id and builtIn', () => {
    const id = usePromptsStore.getState().addCustomPrompt(input());
    usePromptsStore.getState().updateCustomPrompt(id, { name: 'Sharper name' });
    const prompt = usePromptsStore.getState().customPrompts[0];
    expect(prompt?.name).toBe('Sharper name');
    expect(prompt?.id).toBe(id);
    expect(prompt?.builtIn).toBe(false);
  });

  it('deleteCustomPrompt clears the selection when it pointed at the deleted prompt', () => {
    const id = usePromptsStore.getState().addCustomPrompt(input());
    usePromptsStore.getState().setSelectedPrompt(id);
    usePromptsStore.getState().deleteCustomPrompt(id);
    expect(usePromptsStore.getState().customPrompts).toHaveLength(0);
    expect(usePromptsStore.getState().selectedPromptId).toBeNull();
  });

  it('rehydrates persisted customs including sparse generation defaults', async () => {
    window.localStorage.setItem(
      STORAGE_KEYS.prompts,
      JSON.stringify({
        version: 1,
        data: {
          customPrompts: [
            {
              id: 'p1',
              name: 'From disk',
              category: 'custom',
              description: 'restored',
              system: 'sys',
              user: 'do {{input}}',
              requires: ['input'],
              builtIn: false,
              defaults: { temperature: 0.2 },
            },
          ],
          selectedPromptId: 'p1',
        },
      }),
    );
    await usePromptsStore.persist.rehydrate();
    const prompt = usePromptsStore.getState().customPrompts[0];
    expect(prompt?.name).toBe('From disk');
    expect(prompt?.defaults).toEqual({ temperature: 0.2 });
    // The transform rebuilds sparse partials: absent keys stay truly absent.
    expect(Object.keys(prompt?.defaults ?? {})).toEqual(['temperature']);
    expect(usePromptsStore.getState().selectedPromptId).toBe('p1');
  });
});

describe('usePromptsStore persistence round trip (Phase 8)', () => {
  it('a selected built-in id survives rehydrate', async () => {
    window.localStorage.setItem(
      STORAGE_KEYS.prompts,
      JSON.stringify({
        version: 1,
        data: { customPrompts: [], selectedPromptId: 'builtin:proofreading' },
      }),
    );
    await usePromptsStore.persist.rehydrate();
    expect(usePromptsStore.getState().selectedPromptId).toBe('builtin:proofreading');
  });

  it('an added custom round-trips through storage', async () => {
    const id = usePromptsStore.getState().addCustomPrompt(input({ name: 'Round trip' }));
    await vi.waitFor(() => {
      expect(window.localStorage.getItem(STORAGE_KEYS.prompts) ?? '').toContain('Round trip');
    });
    // Capture the write-path output BEFORE resetting: persist middleware
    // writes on every setState, so the reset below overwrites storage.
    const written = window.localStorage.getItem(STORAGE_KEYS.prompts) ?? '';
    usePromptsStore.setState(initial, true);
    window.localStorage.setItem(STORAGE_KEYS.prompts, written);
    await usePromptsStore.persist.rehydrate();
    expect(usePromptsStore.getState().customPrompts[0]?.id).toBe(id);
    expect(usePromptsStore.getState().customPrompts[0]?.name).toBe('Round trip');
  });

  it('never writes built-ins to storage — they ship as code', async () => {
    usePromptsStore.getState().addCustomPrompt(input({ name: 'Round trip' }));
    usePromptsStore.getState().setSelectedPrompt('builtin:proofreading');
    await vi.waitFor(() => {
      expect(window.localStorage.getItem(STORAGE_KEYS.prompts) ?? '').toContain('Round trip');
    });
    const envelope = JSON.parse(window.localStorage.getItem(STORAGE_KEYS.prompts) ?? '{}') as {
      data: { customPrompts: { builtIn: boolean }[] };
    };
    // The selected id may name a built-in; the template array must not carry one.
    expect(envelope.data.customPrompts).toHaveLength(1);
    expect(envelope.data.customPrompts.every((prompt) => !prompt.builtIn)).toBe(true);
  });
});
