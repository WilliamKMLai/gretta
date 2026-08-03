/**
 * Vitest setup (ARCHITECTURE.md §14): jest-dom matchers plus the browser APIs
 * jsdom lacks that Fluent UI may touch during render.
 *
 * The suite runs under jsdom by default, but individual files may opt into the
 * node environment via a `@vitest-environment node` docblock — the live API
 * smoke checks must, because Node's `fetch` rejects an `AbortSignal` built by
 * jsdom's foreign realm. This file is loaded for every environment, so the DOM
 * stubs below are guarded rather than assumed; without the guard, opting a file
 * into node fails at setup with `window is not defined` before a single test
 * runs.
 */
import '@testing-library/jest-dom/vitest';

const hasDom = typeof globalThis.window !== 'undefined';

/*
 * Guarantee `localStorage`, belt and braces.
 *
 * `vitest.config.ts` names an explicit origin so jsdom supplies it, which
 * should be enough. This stays because the failure mode when it is not enough
 * is dreadful: `window.localStorage` comes back undefined rather than throwing,
 * so every storage test dies in `beforeEach` with a message that names no
 * cause, and it reproduces on some machines and not others. A dozen lines here
 * turn an environment-dependent mystery into something that simply works.
 */
if (hasDom && typeof window.localStorage === 'undefined') {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    },
  });
}

// Fluent's MessageBar observes its own size for reflow; jsdom has no layout,
// so the API only needs to exist. Arrow-property style matches matchMedia below.
if (hasDom && typeof window.ResizeObserver !== 'function') {
  class ResizeObserverStub {
    observe = (): void => undefined;
    unobserve = (): void => undefined;
    disconnect = (): void => undefined;
  }
  window.ResizeObserver = ResizeObserverStub;
}

if (hasDom && typeof window.matchMedia !== 'function') {
  const matchMediaStub = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
  window.matchMedia = matchMediaStub;
}
