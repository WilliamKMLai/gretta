import { renderHook } from '@testing-library/react';
import { webDarkTheme, webLightTheme } from '@fluentui/react-components';
import { getServices, initServices } from '../../app/services';
import type { HostInfo } from '../../services/office';
import { useSettingsStore } from './settings.store';
import { useTheme } from './useTheme';

const BROWSER_HOST: HostInfo = { available: false, host: 'unknown', platform: 'unknown' };
const initial = useSettingsStore.getState();

beforeEach(() => {
  window.localStorage.clear();
  useSettingsStore.setState(initial, true);
  initServices(BROWSER_HOST);
});

describe('useTheme', () => {
  it('maps system (jsdom: no matchMedia → light) to the light theme', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe(webLightTheme);
  });

  it('follows an explicit dark preference', () => {
    useSettingsStore.getState().setSettings({ theme: 'dark' });
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe(webDarkTheme);
  });

  it("asks the office service for the 'office' preference", () => {
    useSettingsStore.getState().setSettings({ theme: 'office' });
    vi.spyOn(getServices().office, 'getOfficeTheme').mockReturnValue('dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe(webDarkTheme);
  });
});
