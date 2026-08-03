import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePromptsStore } from '../prompts.store';
import { PromptEditorDialog } from './PromptEditorDialog';

const initial = usePromptsStore.getState();

beforeEach(() => {
  window.localStorage.clear();
  usePromptsStore.setState(initial, true);
});

const renderDialog = (promptId: string | null, onDismiss = vi.fn()): ReturnType<typeof vi.fn> => {
  render(
    <FluentProvider theme={webLightTheme}>
      <PromptEditorDialog open promptId={promptId} onDismiss={onDismiss} />
    </FluentProvider>,
  );
  return onDismiss;
};

describe('PromptEditorDialog', () => {
  it('creates a custom prompt, selects it, and records checked requirements', async () => {
    const user = userEvent.setup();
    const onDismiss = renderDialog(null);

    // Value-level events sidestep the Dialog focus-trap timing in jsdom (see
    // RenameDialog.test.tsx); RHF still runs its onChange validation pass.
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Tighten' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'User template' }), {
      target: { value: 'Tighten: {{selection}}' },
    });
    await user.click(screen.getByRole('checkbox', { name: 'selection' }));

    const create = screen.getByRole('button', { name: 'Create' });
    await waitFor(() => {
      expect(create).toBeEnabled();
    });
    await user.click(create);

    const state = usePromptsStore.getState();
    expect(state.customPrompts).toHaveLength(1);
    const prompt = state.customPrompts[0];
    expect(prompt?.name).toBe('Tighten');
    expect(prompt?.requires).toEqual(['selection']);
    expect(prompt?.builtIn).toBe(false);
    expect(state.selectedPromptId).toBe(prompt?.id);
    expect(onDismiss).toHaveBeenCalled();
  });

  it('names typo placeholders and blocks saving until they are fixed', async () => {
    renderDialog(null);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Broken' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'User template' }), {
      target: { value: 'do {{selektion}} and {{ selection }}' },
    });
    expect(
      await screen.findByText('Unknown placeholders: {{selektion}}, {{ selection }}'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    });
    expect(usePromptsStore.getState().customPrompts).toHaveLength(0);
  });

  it('prefills when editing and Delete removes the prompt', async () => {
    const user = userEvent.setup();
    const id = usePromptsStore.getState().addCustomPrompt({
      name: 'Mine',
      category: 'editing',
      description: 'd',
      system: 's',
      user: 'do {{input}}',
      requires: ['input'],
      defaults: { temperature: 0.3 },
    });
    usePromptsStore.getState().setSelectedPrompt(id);
    const onDismiss = renderDialog(id);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Mine');
    expect(screen.getByRole('checkbox', { name: 'input' })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(usePromptsStore.getState().customPrompts).toHaveLength(0);
    expect(usePromptsStore.getState().selectedPromptId).toBeNull();
    expect(onDismiss).toHaveBeenCalled();
  });
});
