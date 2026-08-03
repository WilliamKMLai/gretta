import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { initServices, setServices } from '../../../app/services';
import type { HostInfo } from '../../../services/office';
import type { OllamaClient, OllamaModel } from '../../../services/ollama';
import { OllamaError } from '../../../types/errors';
import { DEFAULT_SETTINGS, useSettingsStore } from '../settings.store';
import { SettingsPanel } from './SettingsPanel';

const toastSpies = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../../components/toaster', () => ({
  APP_TOASTER_ID: 'test-toaster',
  useAppToasts: () => toastSpies,
}));

const BROWSER_HOST: HostInfo = { available: false, host: 'unknown', platform: 'unknown' };
const initialSettings = useSettingsStore.getState();

const model = (name: string): OllamaModel => ({
  name,
  size: 4_920_000_000,
  modifiedAt: '2026-07-01T00:00:00Z',
  parameterSize: '8.0B',
  quantization: 'Q4_K_M',
});

const stubClient = (overrides: Partial<OllamaClient> = {}): OllamaClient => ({
  health: () => Promise.resolve({ version: '0.6.2' }),
  listModels: () => Promise.resolve([model('llama3.1:8b'), model('mistral:7b')]),
  showModel: () => {
    throw new Error('unused');
  },
  embed: () => {
    throw new Error('unused');
  },
  chat: () => {
    throw new Error('unused');
  },
  generate: () => {
    throw new Error('unused');
  },
  ...overrides,
});

function wrap(children: ReactNode): ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <FluentProvider theme={webLightTheme}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </FluentProvider>
  );
}

const renderPanel = (platform: HostInfo['platform'] = 'PC'): void => {
  render(wrap(<SettingsPanel platform={platform} />));
};

beforeEach(() => {
  window.localStorage.clear();
  useSettingsStore.setState(initialSettings, true);
  setServices({ ollama: stubClient() });
  toastSpies.success.mockClear();
});
afterEach(() => {
  initServices(BROWSER_HOST);
});

/**
 * Opens the Generation accordion. Sampling parameters live behind it now — set
 * once and rarely revisited, but taller than anything else in the panel — so a
 * test that wants the seed has to get there the way a user does.
 */
async function openGeneration(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const header = screen.getByRole('button', { name: /^Generation$/ });
  if (header.getAttribute('aria-expanded') !== 'true') await user.click(header);
}

describe('SettingsPanel', () => {
  it('commits the server URL on blur, not per keystroke', async () => {
    const user = userEvent.setup();
    renderPanel();
    const input = screen.getByRole('textbox', { name: /Ollama server URL/ });
    await user.clear(input);
    await user.type(input, 'https://localhost:11435');
    expect(useSettingsStore.getState().ollamaUrl).toBe(DEFAULT_SETTINGS.ollamaUrl);
    await user.tab();
    expect(useSettingsStore.getState().ollamaUrl).toBe('https://localhost:11435');
  });

  it('refuses to save a malformed URL and says why', async () => {
    const user = userEvent.setup();
    renderPanel();
    const input = screen.getByRole('textbox', { name: /Ollama server URL/ });
    await user.clear(input);
    await user.type(input, 'localhost:11434');
    await user.tab();
    expect(await screen.findByText(/full URL including http/)).toBeInTheDocument();
    // The store still holds the last good value — nothing half-typed escaped.
    expect(useSettingsStore.getState().ollamaUrl).toBe(DEFAULT_SETTINGS.ollamaUrl);
  });

  it('an invalid field does not block a different valid one', async () => {
    const user = userEvent.setup();
    renderPanel();
    const url = screen.getByRole('textbox', { name: /Ollama server URL/ });
    await user.clear(url);
    await user.type(url, 'not-a-url');
    await user.tab();

    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(useSettingsStore.getState().theme).toBe('dark');
    expect(useSettingsStore.getState().ollamaUrl).toBe(DEFAULT_SETTINGS.ollamaUrl);
  });

  it('rejects a non-numeric seed but accepts a whole number', async () => {
    const user = userEvent.setup();
    renderPanel();
    await openGeneration(user);
    const seed = screen.getByRole('textbox', { name: /Seed/ });
    await user.type(seed, '12.5');
    expect(await screen.findByText(/whole number/)).toBeInTheDocument();
    // Committing on blur is what keeps the intermediate '12' out of the store.
    await user.tab();
    expect(useSettingsStore.getState().seed).toBeNull();

    await user.clear(seed);
    await user.type(seed, '42');
    await user.tab();
    await waitFor(() => {
      expect(useSettingsStore.getState().seed).toBe(42);
    });
  });

  it('offers the installed models as the default-model choice', async () => {
    const user = userEvent.setup();
    renderPanel();
    const select = await screen.findByRole('combobox', { name: 'Default model' });
    await waitFor(() => {
      expect(within(select).getByRole('option', { name: 'mistral:7b' })).toBeInTheDocument();
    });
    await user.selectOptions(select, 'mistral:7b');
    expect(useSettingsStore.getState().defaultModel).toBe('mistral:7b');
  });

  it('turns the knowledge base on and back off again', async () => {
    const user = userEvent.setup();
    renderPanel();
    const toggle = await screen.findByRole('switch', { name: /knowledge base/i });
    expect(useSettingsStore.getState().kbEnabled).toBe(false);

    await user.click(toggle);
    expect(useSettingsStore.getState().kbEnabled).toBe(true);

    await user.click(toggle);
    expect(useSettingsStore.getState().kbEnabled).toBe(false);
  });

  it('hides the embedding model until the knowledge base is on', () => {
    // A model picker is meaningless to someone who has not enabled the feature
    // it serves, and showing every control at once is how this panel grew long
    // enough to need reorganising.
    renderPanel();
    expect(screen.queryByRole('combobox', { name: /embedding model/i })).not.toBeInTheDocument();
  });

  it('offers the installed models as the embedding-model choice', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ kbEnabled: true });
    renderPanel();
    const select = await screen.findByRole('combobox', { name: /embedding model/i });
    await waitFor(() => {
      expect(within(select).getByRole('option', { name: 'mistral:7b' })).toBeInTheDocument();
    });
    await user.selectOptions(select, 'mistral:7b');
    expect(useSettingsStore.getState().defaultEmbeddingModel).toBe('mistral:7b');
  });

  it('Test connection reports the daemon version and model count', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Connected to Ollama 0\.6\.2/)).toBeInTheDocument();
    expect(screen.getByText(/2 models available/)).toBeInTheDocument();
  });

  it('Test connection gives the Mac proxy walkthrough for a blocked plain-HTTP call', async () => {
    const user = userEvent.setup();
    setServices({
      ollama: stubClient({
        health: () =>
          Promise.reject(new OllamaError('cors-or-mixed-content', 'blocked by the webview')),
      }),
    });
    renderPanel('Mac');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Word on Mac blocks plain-HTTP/)).toBeInTheDocument();
    // `pnpm proxy` alone also appears in the URL field hint — match the guidance.
    expect(screen.getByText(/then set the server URL/)).toBeInTheDocument();
  });

  it('Test connection tells an offline user how to start the daemon', async () => {
    const user = userEvent.setup();
    setServices({
      ollama: stubClient({
        health: () => Promise.reject(new OllamaError('offline', 'connection refused')),
      }),
    });
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Can't reach Ollama/)).toBeInTheDocument();
    expect(screen.getByText(/ollama serve/)).toBeInTheDocument();
  });

  it('the form re-reads committed text fields after leaving and returning to Settings', async () => {
    // Regression: text fields were registered uncontrolled, so on remount the
    // Fluent Input rendered blank even though the store held the value — the
    // seed box was the visible symptom, but the URL field blanked identically.
    const user = userEvent.setup();
    const first = render(wrap(<SettingsPanel platform="PC" />));

    const url = screen.getByRole('textbox', { name: /Ollama server URL/ });
    await user.clear(url);
    await user.type(url, 'https://box.local:11435');
    await user.tab();

    await openGeneration(user);

    const seed = screen.getByRole('textbox', { name: /Seed/ });
    await user.type(seed, '4242');
    await user.tab();

    await waitFor(() => {
      expect(useSettingsStore.getState().seed).toBe(4242);
    });
    expect(useSettingsStore.getState().ollamaUrl).toBe('https://box.local:11435');

    // Navigate away and back.
    first.unmount();
    render(wrap(<SettingsPanel platform="PC" />));

    expect(screen.getByRole('textbox', { name: /Ollama server URL/ })).toHaveValue(
      'https://box.local:11435',
    );
    await openGeneration(user);
    expect(screen.getByRole('textbox', { name: /Seed/ })).toHaveValue('4242');
  });

  it('a blank seed round-trips as random (null) and stays blank on remount', async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setSettings({ seed: 99 });
    const first = render(wrap(<SettingsPanel platform="PC" />));

    await openGeneration(user);

    const seed = screen.getByRole('textbox', { name: /Seed/ });
    expect(seed).toHaveValue('99');
    await user.clear(seed);
    await user.tab();
    await waitFor(() => {
      expect(useSettingsStore.getState().seed).toBeNull();
    });

    first.unmount();
    render(wrap(<SettingsPanel platform="PC" />));
    await openGeneration(user);
    expect(screen.getByRole('textbox', { name: /Seed/ })).toHaveValue('');
  });
});
