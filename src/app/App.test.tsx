import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { abortActiveGeneration, useAttachmentsStore, useStreamStore } from '../features/ai';
import { useHistoryStore } from '../features/history';
import { useSettingsStore } from '../features/settings';
import type { HostInfo } from '../services/office';
import type { OllamaClient } from '../services/ollama';
import { App } from './App';
import { getServices, initServices, setServices } from './services';
import { useUiStore } from './ui.store';

const BROWSER_HOST: HostInfo = { available: false, host: 'unknown', platform: 'unknown' };

const stubClient = (): OllamaClient => ({
  health: () => Promise.resolve({ version: '0.9.9' }),
  listModels: () => Promise.resolve([]),
  showModel: () => {
    throw new Error('unused');
  },
  embed: () => Promise.resolve([]),
  chat: () => {
    throw new Error('unused');
  },
  generate: () => {
    throw new Error('unused');
  },
});

const initialUi = useUiStore.getState();
const initialSettings = useSettingsStore.getState();
const initialHistory = useHistoryStore.getState();
const initialStream = useStreamStore.getState();

beforeEach(() => {
  window.localStorage.clear();
  abortActiveGeneration();
  useAttachmentsStore.getState().clear();
  useUiStore.setState(initialUi, true);
  useSettingsStore.setState(initialSettings, true);
  useHistoryStore.setState(initialHistory, true);
  useStreamStore.setState(initialStream, true);
  setServices({ ollama: stubClient() });
});
afterEach(() => {
  initServices(BROWSER_HOST);
});

const renderApp = (): void => {
  render(<App hostInfo={BROWSER_HOST} />);
};

describe('App shell', () => {
  it('renders the chat view: brand, pickers, prompt, and a vetoed Generate', async () => {
    renderApp();
    expect(screen.getByText('GRETTA')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeInTheDocument();
    expect(screen.getByText('Ready when you are')).toBeInTheDocument();
    // Browser mode: no models installed → Generate stays vetoed with a reason.
    expect(await screen.findByText('No models installed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
  });

  it('toggles the history view and back', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('No generations yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeInTheDocument();
  });

  it('toggles the settings view with the host caption', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    // The field is `required` since Phase 9, so its label carries an asterisk.
    expect(screen.getByRole('textbox', { name: /Ollama server URL/ })).toBeInTheDocument();
    expect(screen.getByText(/Browser dev mode/)).toBeInTheDocument();
  });

  it('opens a past generation from history and returns to chat', async () => {
    const user = userEvent.setup();
    useHistoryStore.setState({
      records: [
        {
          id: 'rec-1',
          createdAt: new Date().toISOString(),
          prompt: 'tighten this paragraph',
          response: 'Tightened.',
          model: 'llama3',
          outcome: 'completed',
        },
      ],
      activeRecordId: null,
    });
    renderApp();

    await user.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByText('tighten this paragraph')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^tighten this paragraph/ }));
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeInTheDocument();
    expect(useHistoryStore.getState().activeRecordId).toBe('rec-1');
  });

  it('routes Ctrl+Enter through the generate veto and toasts the reason', async () => {
    renderApp();
    await screen.findByText('No models installed');
    // The reason already exists in the disabled button's tooltip machinery;
    // the shortcut must ADD one more occurrence (the toast), so assert the delta.
    const before = screen.queryAllByText('Pick a model first').length;
    fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(screen.queryAllByText('Pick a model first').length).toBeGreaterThan(before);
    });
  });

  it('New prompt in the header clears staged attachments, draft, and active record', async () => {
    const user = userEvent.setup();
    useAttachmentsStore.getState().add([
      {
        id: 'img-1',
        name: 'plot.png',
        dataBase64: 'AAAA',
        width: 100,
        height: 100,
        bytes: 3,
      },
    ]);
    useUiStore.getState().setDraft('draft question');
    useHistoryStore.setState({ activeRecordId: 'rec-1', records: [] });
    renderApp();

    await user.click(
      within(screen.getByRole('banner')).getByRole('button', { name: 'New prompt' }),
    );
    expect(useAttachmentsStore.getState().images).toEqual([]);
    expect(useUiStore.getState().draft).toBe('');
    expect(useHistoryStore.getState().activeRecordId).toBeNull();
  });

  it('Ctrl+Shift+I strips Markdown and marks applied only on success', async () => {
    const id = useHistoryStore.getState().addRecord({
      prompt: 'write heading',
      response: '## Intro\n\n**Key** point',
      model: 'llama3',
      outcome: 'completed',
    });
    const record = useHistoryStore.getState().records[0];
    if (record !== undefined) useStreamStore.getState().restore(record);
    const insertSpy = vi
      .spyOn(getServices().office, 'insertAtCursor')
      .mockRejectedValueOnce(new Error('Word busy'))
      .mockResolvedValueOnce(undefined);

    renderApp();

    fireEvent.keyDown(document, { key: 'I', code: 'KeyI', ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      expect(insertSpy).toHaveBeenCalledWith('Intro\n\nKey point');
    });
    expect(useHistoryStore.getState().records.find((r) => r.id === id)?.applied).toBeUndefined();

    fireEvent.keyDown(document, { key: 'I', code: 'KeyI', ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      expect(useHistoryStore.getState().records.find((r) => r.id === id)?.applied?.kind).toBe(
        'insert',
      );
    });
  });

  it('renders "replaced" badge in History and confirms before Clear all', async () => {
    const user = userEvent.setup();
    useHistoryStore.setState({
      records: [
        {
          id: 'rec-replace',
          createdAt: new Date().toISOString(),
          prompt: 'rewrite abstract',
          response: 'Rewritten.',
          model: 'llama3',
          outcome: 'completed',
          applied: { kind: 'replace', at: new Date().toISOString() },
        },
      ],
      activeRecordId: null,
    });
    renderApp();

    await user.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByText('replaced')).toBeInTheDocument();
    expect(screen.queryByText('replaceed')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(
      await screen.findByText('Clear generation history?', {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(useHistoryStore.getState().records).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    expect(useHistoryStore.getState().records).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    await user.click(
      await screen.findByRole('button', { name: 'Clear history' }, { timeout: 3000 }),
    );
    expect(useHistoryStore.getState().records).toEqual([]);
    expect(screen.getByText('No generations yet')).toBeInTheDocument();
  });
});
