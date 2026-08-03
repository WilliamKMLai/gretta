/**
 * Pane size awareness (DECISIONS.md ADR-027).
 *
 * A Word task pane is resized by dragging the document edge, and users squash
 * it far shorter than any desktop layout assumes. The pane *is* the window, so
 * `innerHeight` measures it exactly — no ResizeObserver, and it works under
 * jsdom where ResizeObserver does not exist.
 *
 * Below the compact threshold the chat view stops trying to show the composer,
 * the result, and the action bar simultaneously — at ~500 px there is not room
 * for all three, and forcing it is what makes regions collapse to nothing and
 * controls overlap.
 */
import { useEffect, useState } from 'react';

/**
 * Height below which the pane cannot show composer + result + actions at once.
 * Derived from the fixed chrome: header ~64, pickers ~64, composer ~120,
 * controls ~48, actions ~48, leaving under ~150 px of result at 560.
 */
export const COMPACT_HEIGHT = 560;

export interface PaneLayout {
  height: number;
  /** True when vertical space is too tight for the full layout. */
  compact: boolean;
}

function measure(): number {
  return typeof window === 'undefined' ? COMPACT_HEIGHT + 1 : window.innerHeight;
}

export function usePaneLayout(): PaneLayout {
  const [height, setHeight] = useState<number>(measure);

  useEffect(() => {
    const onResize = (): void => {
      setHeight(measure());
    };
    window.addEventListener('resize', onResize);
    // Office restores pane size after the add-in mounts, so measure once more.
    onResize();
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return { height, compact: height < COMPACT_HEIGHT };
}
