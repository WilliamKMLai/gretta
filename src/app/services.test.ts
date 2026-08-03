import { useSettingsStore } from '../features/settings';
import { MockOfficeService } from '../services/office';
import type { HostInfo } from '../services/office';
import type { OllamaClient, OllamaClientConfig } from '../services/ollama';
import {
  createSettingsBoundOllamaClient,
  getServices,
  initServices,
  setServices,
} from './services';

const BROWSER_HOST: HostInfo = { available: false, host: 'unknown', platform: 'unknown' };

const stubClient = (overrides: Partial<OllamaClient> = {}): OllamaClient => ({
  health: () => Promise.resolve({ version: '0.0.0' }),
  listModels: () => Promise.resolve([]),
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

afterEach(() => {
  initServices(BROWSER_HOST);
  useSettingsStore.getState().resetSettings();
  window.localStorage.clear();
});

describe('composition root', () => {
  it('lazily provides browser-safe defaults (mock Office) with zero setup', () => {
    expect(getServices().office).toBeInstanceOf(MockOfficeService);
    expect(getServices().storage).toBeDefined();
    expect(getServices().clipboard).toBeDefined();
  });

  it('setServices swaps a single slice for tests', () => {
    const fakeClipboard = { copy: vi.fn(() => Promise.resolve()) };
    setServices({ clipboard: fakeClipboard });
    expect(getServices().clipboard).toBe(fakeClipboard);
    expect(getServices().office).toBeInstanceOf(MockOfficeService);
  });

  it('the settings-bound Ollama client resolves the base URL at call time', async () => {
    const captured: string[] = [];
    const factory = (config: OllamaClientConfig): OllamaClient => {
      captured.push(config.baseUrl);
      return stubClient();
    };
    const client = createSettingsBoundOllamaClient(factory);

    await client.health();
    useSettingsStore.getState().setSettings({ ollamaUrl: 'https://localhost:11435' });
    await client.health();

    expect(captured).toEqual(['http://127.0.0.1:11434', 'https://localhost:11435']);
  });
});
