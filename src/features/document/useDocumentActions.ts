/**
 * Result → document/clipboard actions (ARCHITECTURE.md §5.3, §10). The only
 * place the UI touches office/clipboard services; every action resolves to a
 * toast (success or friendly failure) and never throws into React.
 */
import { useMemo } from 'react';
import { useAppToasts } from '../../components/toaster';
import { getServices } from '../../app/services';
import { WORD_API_COMMENTS } from '../../services/office';

export interface DocumentActions {
  copy: (text: string) => Promise<void>;
  replaceSelection: (text: string) => Promise<void>;
  insertAtCursor: (text: string) => Promise<void>;
  appendText: (text: string) => Promise<void>;
  comment: (text: string) => Promise<void>;
  /** Runtime WordApi 1.4 gate for the Comment action. */
  commentsSupported: boolean;
}

export function useDocumentActions(): DocumentActions {
  const toasts = useAppToasts();

  return useMemo(() => {
    const attempt = async (success: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
        toasts.success(success);
      } catch (error) {
        toasts.error(error instanceof Error ? error.message : 'The action failed — try again.');
      }
    };

    return {
      copy: (text) => attempt('Copied to clipboard', () => getServices().clipboard.copy(text)),
      replaceSelection: (text) =>
        attempt('Selection replaced', () => getServices().office.replaceSelection(text)),
      insertAtCursor: (text) =>
        attempt('Inserted at cursor', () => getServices().office.insertAtCursor(text)),
      appendText: (text) =>
        attempt('Appended to document', () => getServices().office.appendText(text)),
      comment: (text) =>
        attempt('Comment added to selection', () => getServices().office.createComment(text)),
      commentsSupported: getServices().office.isApiSupported('WordApi', WORD_API_COMMENTS),
    };
  }, [toasts]);
}
