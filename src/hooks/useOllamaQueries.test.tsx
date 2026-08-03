import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { initServices, setServices } from '../app/services';
import type { HostInfo } from '../services/office';
import type { OllamaClient, OllamaModel } from '../services/ollama';
import { useModels, useOllamaHealth } from './useOllamaQueries';

const BROWSER_HOST: HostInfo = { available: false, host: 'unknown', platform: 'unknown' };

const models: OllamaModel[] = [
  {
    name: 'llama3.1:8b',
    size: 4_920_000_000,
    modifiedAt: '2026-07-01T00:00:00Z',
    parameterSize: '8.0B',
    quantization: 'Q4_K_M',
  },
];

const stubClient = (overrides: Partial<OllamaClient> = {}): OllamaClient => ({
  health: () => Promise.resolve({ version: '0.9.9' }),
  listModels: () => Promise.resolve(models),
  showModel: () => {
    throw new Error('unused in this test');
  },
  embed: () => {
    throw new Error('unused');
  },
  chat: () => {
    throw new Error('unused in this test');
  },
  generate: () => {
    throw new Error('unused in this test');
  },
  ...overrides,
});

// Built inline (not app/queryClient): hooks stay decoupled from app wiring, and tests
// want retry:false so failures surface immediately.
function makeWrapper(): ({ children }: { children: ReactNode }) => ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  initServices(BROWSER_HOST);
});

describe('Ollama server-cache hooks', () => {
  it('useModels returns the installed models from the composed client', async () => {
    const listModels = vi.fn(() => Promise.resolve(models));
    setServices({ ollama: stubClient({ listModels }) });

    const { result } = renderHook(() => useModels(), { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data).toEqual(models);
    expect(listModels).toHaveBeenCalled();
  });

  it('useOllamaHealth surfaces the daemon version', async () => {
    setServices({ ollama: stubClient() });

    const { result } = renderHook(() => useOllamaHealth(), { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data).toEqual({ version: '0.9.9' });
  });
});
