/**
 * Resolves the ThemePreference into a Fluent theme (ARCHITECTURE.md §10,
 * ADR-013b). Lives in features/settings rather than src/hooks: the layer
 * matrix bars hooks/ from features and the composition root, and this hook
 * needs the settings store and the office service.
 *
 * 'office' asks the host (null in browser dev mode → falls back to system);
 * 'system' tracks prefers-color-scheme live.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Theme } from '@fluentui/react-components';
import { webDarkTheme, webLightTheme } from '@fluentui/react-components';
import { getServices } from '../../app/services';
import { useSettingsStore } from './settings.store';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** jsdom (and some old webviews) lack matchMedia — treat it as optional. */
function queryList(): MediaQueryList | null {
  const matchMedia = (window as { matchMedia?: typeof window.matchMedia }).matchMedia;
  return matchMedia === undefined ? null : matchMedia(DARK_QUERY);
}

export function useTheme(): Theme {
  const preference = useSettingsStore((state) => state.theme);
  const [systemDark, setSystemDark] = useState(() => queryList()?.matches ?? false);

  useEffect(() => {
    const list = queryList();
    if (list === null) return;
    const onChange = (event: MediaQueryListEvent): void => {
      setSystemDark(event.matches);
    };
    list.addEventListener('change', onChange);
    return () => {
      list.removeEventListener('change', onChange);
    };
  }, []);

  return useMemo(() => {
    const officeTheme = preference === 'office' ? getServices().office.getOfficeTheme() : null;
    const dark =
      preference === 'dark' ||
      (preference === 'system' && systemDark) ||
      (preference === 'office' && (officeTheme ?? (systemDark ? 'dark' : 'light')) === 'dark');
    return dark ? webDarkTheme : webLightTheme;
  }, [preference, systemDark]);
}
