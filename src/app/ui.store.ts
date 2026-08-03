/**
 * Ephemeral UI state (ARCHITECTURE.md §8): active view, the prompt draft
 * (kept here so switching views never loses typed text), and the selected
 * document-context source. Dialog state stays local to its owner.
 */
import { create } from 'zustand';
import type { ContextSource } from '../types/domain';

export type AppView = 'chat' | 'history' | 'settings' | 'knowledge-base' | 'literature';

export interface UiState {
  view: AppView;
  setView: (view: AppView) => void;
  draft: string;
  setDraft: (draft: string) => void;
  contextSource: ContextSource;
  setContextSource: (source: ContextSource) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  view: 'chat',
  setView: (view) => {
    set({ view });
  },
  draft: '',
  setDraft: (draft) => {
    set({ draft });
  },
  contextSource: 'none',
  setContextSource: (contextSource) => {
    set({ contextSource });
  },
}));
