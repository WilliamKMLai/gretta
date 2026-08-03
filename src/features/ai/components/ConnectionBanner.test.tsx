import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { initServices, setServices } from '../../../app/services';
import type { HostInfo } from '../../../services/office';
import type { OllamaClient } from '../../../services/ollama';
import { OllamaError } from '../../../types/errors';
import { useSettingsStore } from '../../settings';
import { ConnectionBanner } from './ConnectionBanner';

const BROWSER_HOST: HostInfo = { available: false, host: 'unknown', platform: 'unknown' };
const initialSettings = useSettingsStore.getState();

const stubClient = (health: OllamaClient['health']): OllamaClient => ({
  health,
  listModels: () => Promise.resolve([]),
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

describe('ConnectionBanner', () => {
  it('renders nothing while the daemon is healthy', async () => {
    const health = vi.fn(() => Promise.resolve({ version: '0.9.9' }));
    setServices({ ollama: stubClient(health) });
    render(wrap(<ConnectionBanner platform="unknown" />));
    await waitFor(() => {
      expect(health).toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('offers restart guidance when Ollama is offline', async () => {
    setServices({
      ollama: stubClient(() =>
        Promise.reject(new OllamaError('offline', 'fetch failed: connection refused')),
      ),
    });
    render(wrap(<ConnectionBanner platform="PC" />));
    expect(await screen.findByText(/Can't reach Ollama at/)).toBeInTheDocument();
    expect(screen.getByText(/ollama serve/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('walks Mac + plain-HTTP users to the proxy', async () => {
    setServices({
      ollama: stubClient(() => Promise.reject(new OllamaError('cors-or-mixed-content', 'blocked'))),
    });
    render(wrap(<ConnectionBanner platform="Mac" />));
    expect(await screen.findByText('Word on Mac blocks plain-HTTP requests')).toBeInTheDocument();
    expect(screen.getByText(/pnpm proxy/)).toBeInTheDocument();
  });
});
