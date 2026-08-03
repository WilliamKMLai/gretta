import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import type { ShortcutHandlers } from './useKeyboardShortcuts';

function Probe({ handlers }: { handlers: ShortcutHandlers }): ReactElement {
  useKeyboardShortcuts(handlers);
  return <div />;
}

describe('useKeyboardShortcuts', () => {
  it('fires generate on Ctrl/⌘+Enter', () => {
    const onGenerate = vi.fn();
    render(<Probe handlers={{ onGenerate }} />);
    fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true });
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it('fires stop on Escape', () => {
    const onStop = vi.fn();
    render(<Probe handlers={{ onStop }} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('fires copy on Ctrl/⌘+Shift+C', () => {
    const onCopy = vi.fn();
    render(<Probe handlers={{ onCopy }} />);
    fireEvent.keyDown(document, { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true });
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it('fires insert on Ctrl/⌘+Shift+I and stops listening after unmount', () => {
    const onInsert = vi.fn();
    const { unmount } = render(<Probe handlers={{ onInsert }} />);
    fireEvent.keyDown(document, { key: 'I', code: 'KeyI', metaKey: true, shiftKey: true });
    expect(onInsert).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(document, { key: 'I', code: 'KeyI', metaKey: true, shiftKey: true });
    expect(onInsert).toHaveBeenCalledTimes(1);
  });
});
