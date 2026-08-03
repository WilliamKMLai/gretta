import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { initServices, setServices } from '../../../app/services';
import type { HostInfo } from '../../../services/office';
import type { OllamaClient, OllamaModel } from '../../../services/ollama';
import { useSettingsStore } from '../../settings';
import { ModelPicker } from './ModelPicker';

const BROWSER_HOST: HostInfo = { available: false, host: 'unknown', platform: 'unknown' };
const initialSettings = useSettingsStore.getState();

const model: OllamaModel = {
  name: 'llama3.1:8b',
  size: 4_920_000_000,
  modifiedAt: '2026-07-01T00:00:00Z',
  parameterSize: '8.0B',
  quantization: 'Q4_K_M',
};

const stubClient = (overrides: Partial<OllamaClient> = {}): OllamaClient => ({
  health: () => Promise.resolve({ version: '0.0.0' }),
  listModels: () => Promise.resolve([model]),
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

beforeEach(() => {
  window.localStorage.clear();
  useSettingsStore.setState(initialSettings, true);
});
afterEach(() => {
  initServices(BROWSER_HOST);
});

describe('ModelPicker', () => {
  it('shows the loading state while the list is pending', () => {
    setServices({ ollama: stubClient({ listModels: () => new Promise(() => undefined) }) });
    render(wrap(<ModelPicker />));
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled();
    expect(screen.getByText('Loading models…')).toBeInTheDocument();
  });

  it('shows the empty state with a pull hint', async () => {
    setServices({ ollama: stubClient({ listModels: () => Promise.resolve([]) }) });
    render(wrap(<ModelPicker />));
    await waitFor(() => {
      expect(screen.getByText('No models installed')).toBeInTheDocument();
    });
    expect(screen.getByText(/ollama pull/)).toBeInTheDocument();
  });

  it('persists the selection to settings.defaultModel', async () => {
    const user = userEvent.setup();
    setServices({ ollama: stubClient() });
    render(wrap(<ModelPicker />));
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Model' })).toBeEnabled();
    });
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(await screen.findByRole('option', { name: /llama3\.1:8b/ }));
    expect(useSettingsStore.getState().defaultModel).toBe('llama3.1:8b');
  });
});
