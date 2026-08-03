/**
 * The commit boundary in isolation (ADR-016): what reaches the store, what
 * doesn't, and how the form reacts when the store moves underneath it.
 */
import { act, renderHook } from '@testing-library/react';
import { DEFAULT_SETTINGS, useSettingsStore } from './settings.store';
import { useSettingsForm } from './useSettingsForm';

const initial = useSettingsStore.getState();

beforeEach(() => {
  window.localStorage.clear();
  useSettingsStore.setState(initial, true);
});

describe('useSettingsForm', () => {
  it('starts from the store values', () => {
    useSettingsStore.getState().setSettings({ temperature: 1.2, seed: 7 });
    const { result } = renderHook(() => useSettingsForm());
    expect(result.current.form.getValues('temperature')).toBe(1.2);
    expect(result.current.form.getValues('seed')).toBe('7');
  });

  it('commits a valid field to the store', () => {
    const { result } = renderHook(() => useSettingsForm());
    act(() => {
      result.current.setAndCommit('temperature', 1.4);
    });
    expect(useSettingsStore.getState().temperature).toBe(1.4);
  });

  it('keeps an invalid value out of the store but leaves it in the form', () => {
    const { result } = renderHook(() => useSettingsForm());
    act(() => {
      result.current.form.setValue('ollamaUrl', 'not-a-url');
      result.current.commit('ollamaUrl');
    });
    expect(useSettingsStore.getState().ollamaUrl).toBe(DEFAULT_SETTINGS.ollamaUrl);
    // The text stays on screen so the user can fix it rather than losing it.
    expect(result.current.form.getValues('ollamaUrl')).toBe('not-a-url');
  });

  it('picks up an external change to a single field', () => {
    const { result } = renderHook(() => useSettingsForm());
    act(() => {
      // What the header ModelPicker does while Settings is open.
      useSettingsStore.getState().setSettings({ defaultModel: 'mistral:7b' });
    });
    expect(result.current.form.getValues('defaultModel')).toBe('mistral:7b');
  });

  it('an unrelated external change does not discard in-progress typing', () => {
    const { result } = renderHook(() => useSettingsForm());
    act(() => {
      result.current.form.setValue('ollamaUrl', 'http://192.168.1.10:114');
    });
    act(() => {
      useSettingsStore.getState().setSettings({ defaultModel: 'mistral:7b' });
    });
    expect(result.current.form.getValues('ollamaUrl')).toBe('http://192.168.1.10:114');
    expect(result.current.form.getValues('defaultModel')).toBe('mistral:7b');
  });

  it('reset-to-defaults wins over an uncommitted edit', () => {
    useSettingsStore.getState().setSettings({ temperature: 1.9 });
    const { result } = renderHook(() => useSettingsForm());
    act(() => {
      result.current.form.setValue('ollamaUrl', 'http://half-typed');
    });
    act(() => {
      // Exactly what the Reset to defaults button does.
      useSettingsStore.getState().resetSettings();
      result.current.resetForm();
    });
    expect(result.current.form.getValues('ollamaUrl')).toBe(DEFAULT_SETTINGS.ollamaUrl);
    expect(result.current.form.getValues('temperature')).toBe(DEFAULT_SETTINGS.temperature);
  });

  it('a commit does not bounce back through the subscription', () => {
    const { result } = renderHook(() => useSettingsForm());
    act(() => {
      result.current.form.setValue('seed', '42');
      result.current.commit('seed');
    });
    expect(useSettingsStore.getState().seed).toBe(42);
    expect(result.current.form.getValues('seed')).toBe('42');
  });
});
