/**
 * Reads and writes the active document's knowledge-base binding (ADR-020).
 *
 * The binding is stored in the .docx through `Office.context.document.settings`
 * (behind the office service — rule zero), so it survives copy/rename/move and
 * travels with the file. Any set of documents that should draw on the same
 * material binds to the same collection, and because the binding is part of the
 * file, a template that carries one passes it to every document created from it;
 * an unrelated document keeps its own binding, or none. In browser dev mode the
 * office mock keeps it in memory.
 */
import { useCallback, useEffect } from 'react';
import { getServices } from '../../app/services';
import {
  KB_BINDING_KEY,
  LEGACY_KB_BINDING_KEY,
  useKnowledgeBaseStore,
} from './knowledgebase.store';

function parseIds(raw: string | null): string[] {
  if (raw === null || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export interface UseDocumentBindingResult {
  boundCollectionIds: string[];
  bindingLoaded: boolean;
  /** Adds or removes one collection from the open document's binding. */
  toggleCollection: (id: string, bound: boolean) => Promise<void>;
}

export function useDocumentBinding(): UseDocumentBindingResult {
  const boundCollectionIds = useKnowledgeBaseStore((state) => state.boundCollectionIds);
  const bindingLoaded = useKnowledgeBaseStore((state) => state.bindingLoaded);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      let raw = await getServices().office.getDocumentSetting(KB_BINDING_KEY);
      // A document bound by the pre-rebrand build (ADR-024).
      raw ??= await getServices().office.getDocumentSetting(LEGACY_KB_BINDING_KEY);
      if (controller.signal.aborted) return; // document/pane closed mid-read
      const store = useKnowledgeBaseStore.getState();
      store.setBinding(parseIds(raw));
      store.markBindingLoaded();
    })();
    return () => {
      controller.abort();
    };
  }, []);

  const toggleCollection = useCallback(async (id: string, bound: boolean): Promise<void> => {
    const current = useKnowledgeBaseStore.getState().boundCollectionIds;
    const next = bound ? [...new Set([...current, id])] : current.filter((value) => value !== id);
    useKnowledgeBaseStore.getState().setBinding(next);
    await getServices().office.setDocumentSetting(
      KB_BINDING_KEY,
      next.length === 0 ? null : JSON.stringify(next),
    );
  }, []);

  return { boundCollectionIds, bindingLoaded, toggleCollection };
}
