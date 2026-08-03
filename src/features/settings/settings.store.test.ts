import type { MockInstance } from 'vitest';
import { STORAGE_KEYS, STORAGE_VERSIONS } from '../../services/storage';
import { DEFAULT_SETTINGS, useSettingsStore } from './settings.store';

const initial = useSettingsStore.getState();
let warnSpy: MockInstance<typeof console.warn>;

beforeEach(() => {
  window.localStorage.clear();
  useSettingsStore.setState(initial, true);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe('useSettingsStore', () => {
  it('starts from the ARCH §6 defaults', () => {
    expect(useSettingsStore.getState()).toMatchObject(DEFAULT_SETTINGS);
  });

  it('setSettings patches shallowly without touching other fields', () => {
    useSettingsStore.getState().setSettings({ temperature: 1.2, theme: 'dark' });
    const state = useSettingsStore.getState();
    expect(state.temperature).toBe(1.2);
    expect(state.theme).toBe('dark');
    expect(state.ollamaUrl).toBe(DEFAULT_SETTINGS.ollamaUrl);
    expect(state.topK).toBe(DEFAULT_SETTINGS.topK);
  });

  it('resetSettings restores every default', () => {
    useSettingsStore.getState().setSettings({ ollamaUrl: 'https://localhost:11435', topK: 7 });
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState()).toMatchObject(DEFAULT_SETTINGS);
  });

  it('persists the versioned envelope with data only (no actions)', async () => {
    useSettingsStore.getState().setSettings({ temperature: 1.2 });
    await vi.waitFor(() => {
      const raw = window.localStorage.getItem(STORAGE_KEYS.settings) ?? '';
      // Read from the constant: hardcoding it means every future migration
      // breaks a test that is not about migrations.
      expect(raw).toContain(`"version":${String(STORAGE_VERSIONS[STORAGE_KEYS.settings])}`);
      expect(raw).toContain('"temperature":1.2');
      expect(raw).not.toContain('setSettings');
    });
  });

  it('rehydrates a valid stored envelope', async () => {
    window.localStorage.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({ version: 2, data: { ...DEFAULT_SETTINGS, temperature: 1.3 } }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().temperature).toBe(1.3);
  });

  it('keeps the coded defaults (with a warning) when the payload is corrupt', async () => {
    window.localStorage.setItem(
      STORAGE_KEYS.settings,
      '{"version":2,"data":{"temperature":"hot"}}',
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().temperature).toBe(DEFAULT_SETTINGS.temperature);
    expect(warnSpy).toHaveBeenCalled();
  });
});
