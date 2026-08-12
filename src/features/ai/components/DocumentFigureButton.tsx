/**
 * "Use figure from document" — the Word-native door (ADR-035).
 *
 * Renders nothing outside Word. This is the `FolderPickerButton` case rather
 * than the `ImageAttachButton` case: there is no document to read in browser
 * dev mode and no setting that would create one, so the button could never do
 * anything. `ImageAttachButton` stays visible when the model cannot see because
 * that is one settings change away; this is not.
 */
import type { ReactElement } from 'react';
import { Button, Spinner, Tooltip } from '@fluentui/react-components';
import { DocumentRegular } from '@fluentui/react-icons';
import { useImageAttach } from '../useImageAttach';
import { MAX_ATTACHMENTS, useAttachmentsStore } from '../attachments.store';

export interface DocumentFigureButtonProps {
  /** `hostInfo.available` — true only inside Word with Office.js ready. */
  available: boolean;
  disabled?: boolean;
}

export function DocumentFigureButton({
  available,
  disabled = false,
}: DocumentFigureButtonProps): ReactElement | null {
  const { attachFromDocument, isPreparing } = useImageAttach();
  const count = useAttachmentsStore((state) => state.images.length);

  if (!available) return null;
  const full = count >= MAX_ATTACHMENTS;

  return (
    <Tooltip
      content={
        full ? `Up to ${String(MAX_ATTACHMENTS)} images` : 'Use the figure selected in the document'
      }
      relationship="label"
    >
      <Button
        appearance="subtle"
        size="small"
        icon={isPreparing ? <Spinner size="tiny" /> : <DocumentRegular />}
        disabled={disabled || isPreparing || full}
        onClick={() => {
          void attachFromDocument();
        }}
        aria-label="Use the figure selected in the document"
      />
    </Tooltip>
  );
}
