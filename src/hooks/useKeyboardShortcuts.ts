/**
 * Global keyboard shortcuts (ARCHITECTURE.md §10), registered once:
 *   Ctrl/⌘+Enter → generate · Esc → stop ·
 *   Ctrl/⌘+Shift+C → copy result · Ctrl/⌘+Shift+I → insert at cursor
 *
 * Listens on `document`, which inside a task-pane webview is scoped to the
 * pane — Word's own shortcuts are unaffected. Handlers are read through a ref
 * so callers may pass fresh closures every render without re-binding.
 */
import { useEffect, useRef } from 'react';

export interface ShortcutHandlers {
  onGenerate?: () => void;
  onStop?: () => void;
  onCopy?: () => void;
  onInsert?: () => void;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && event.key === 'Enter' && ref.current.onGenerate) {
        event.preventDefault();
        ref.current.onGenerate();
      } else if (event.key === 'Escape' && ref.current.onStop) {
        ref.current.onStop();
      } else if (mod && event.shiftKey && event.code === 'KeyC' && ref.current.onCopy) {
        event.preventDefault();
        ref.current.onCopy();
      } else if (mod && event.shiftKey && event.code === 'KeyI' && ref.current.onInsert) {
        event.preventDefault();
        ref.current.onInsert();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
