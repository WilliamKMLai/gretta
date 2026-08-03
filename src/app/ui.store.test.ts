import { useUiStore } from './ui.store';

const initial = useUiStore.getState();
beforeEach(() => {
  useUiStore.setState(initial, true);
});

describe('useUiStore', () => {
  it('defaults to the chat view and switches on setView', () => {
    expect(useUiStore.getState().view).toBe('chat');
    useUiStore.getState().setView('settings');
    expect(useUiStore.getState().view).toBe('settings');
  });

  it('keeps the prompt draft and context source across view switches', () => {
    useUiStore.getState().setDraft('half-typed prompt');
    useUiStore.getState().setContextSource('document');
    useUiStore.getState().setView('history');
    useUiStore.getState().setView('chat');
    expect(useUiStore.getState().draft).toBe('half-typed prompt');
    expect(useUiStore.getState().contextSource).toBe('document');
  });
});
