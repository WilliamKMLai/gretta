/** Pane size awareness (ADR-027). */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { COMPACT_HEIGHT, usePaneLayout } from './usePaneLayout';

function setHeight(px: number): void {
  Object.defineProperty(window, 'innerHeight', { value: px, configurable: true, writable: true });
}

afterEach(() => {
  setHeight(768);
});

describe('usePaneLayout', () => {
  it('reports a tall pane as roomy', () => {
    setHeight(900);
    const { result } = renderHook(() => usePaneLayout());
    expect(result.current.compact).toBe(false);
    expect(result.current.height).toBe(900);
  });

  it('reports a squashed pane as compact', () => {
    setHeight(420);
    const { result } = renderHook(() => usePaneLayout());
    expect(result.current.compact).toBe(true);
  });

  it('treats the threshold itself as roomy, and one pixel under as compact', () => {
    setHeight(COMPACT_HEIGHT);
    expect(renderHook(() => usePaneLayout()).result.current.compact).toBe(false);
    setHeight(COMPACT_HEIGHT - 1);
    expect(renderHook(() => usePaneLayout()).result.current.compact).toBe(true);
  });

  it('responds when the user drags the pane edge', () => {
    setHeight(900);
    const { result } = renderHook(() => usePaneLayout());
    expect(result.current.compact).toBe(false);
    act(() => {
      setHeight(400);
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current.compact).toBe(true);
  });

  it('stops listening once unmounted', () => {
    setHeight(900);
    const { result, unmount } = renderHook(() => usePaneLayout());
    unmount();
    act(() => {
      setHeight(300);
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current.height).toBe(900);
  });
});
