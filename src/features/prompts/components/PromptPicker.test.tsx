import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { usePromptsStore } from '../prompts.store';
import { PromptPicker } from './PromptPicker';

const initial = usePromptsStore.getState();

beforeEach(() => {
  window.localStorage.clear();
  usePromptsStore.setState(initial, true);
});

const renderPicker = (): ReturnType<typeof render> =>
  render(
    (
      <FluentProvider theme={webLightTheme}>
        <PromptPicker />
      </FluentProvider>
    ) as ReactElement,
  );

describe('PromptPicker', () => {
  it('lists Free prompt, category groups, and the New prompt action', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole('combobox', { name: 'Prompt template' }));
    expect(screen.getByRole('option', { name: 'Free prompt' })).toBeInTheDocument();
    for (const label of ['Scientific', 'Editing', 'Journal style', 'Grants', 'Communication']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole('option', { name: 'Proofreading' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /New prompt/ })).toBeInTheDocument();
    // No customs yet → no "My prompts" group.
    expect(screen.queryByText('My prompts')).not.toBeInTheDocument();
  });

  it('selecting a built-in stores its id', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole('combobox', { name: 'Prompt template' }));
    await user.click(screen.getByRole('option', { name: 'Proofreading' }));
    expect(usePromptsStore.getState().selectedPromptId).toBe('builtin:proofreading');
  });

  it('New prompt opens the editor without changing the selection', async () => {
    const user = userEvent.setup();
    usePromptsStore.getState().setSelectedPrompt('builtin:grammar');
    renderPicker();
    await user.click(screen.getByRole('combobox', { name: 'Prompt template' }));
    await user.click(screen.getByRole('option', { name: /New prompt/ }));
    expect(await screen.findByText('New prompt', { selector: 'h2, div' })).toBeInTheDocument();
    expect(usePromptsStore.getState().selectedPromptId).toBe('builtin:grammar');
  });

  it('shows the edit button only while a custom prompt is selected', () => {
    const id = usePromptsStore.getState().addCustomPrompt({
      name: 'Mine',
      category: 'custom',
      description: '',
      system: '',
      user: 'do {{input}}',
      requires: ['input'],
    });
    usePromptsStore.getState().setSelectedPrompt(id);
    const { rerender } = renderPicker();
    expect(screen.getByRole('button', { name: 'Edit prompt Mine' })).toBeInTheDocument();

    usePromptsStore.getState().setSelectedPrompt('builtin:proofreading');
    rerender(
      <FluentProvider theme={webLightTheme}>
        <PromptPicker />
      </FluentProvider>,
    );
    expect(screen.queryByRole('button', { name: /Edit prompt/ })).not.toBeInTheDocument();
  });
});
