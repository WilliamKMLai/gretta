/**
 * "Attach image" — the file-picker door (ADR-034).
 *
 * Renders unconditionally, including when the resolved model cannot read
 * images. That is the opposite of `FolderPickerButton`, which returns null when
 * the companion has no dialog, and the difference is deliberate: a folder
 * picker with no dialog behind it can never work, whereas this is one settings
 * change away. Hiding it would mean a user whose model happens to be text-only
 * never discovers the feature exists, let alone what to change. So the button
 * stays and `AttachmentStrip` explains the gap once something is attached.
 */
import { useRef } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import { Button, Spinner, Tooltip } from '@fluentui/react-components';
import { ImageAddRegular } from '@fluentui/react-icons';
import { useImageAttach } from '../useImageAttach';
import { MAX_ATTACHMENTS, useAttachmentsStore } from '../attachments.store';

export interface ImageAttachButtonProps {
  disabled?: boolean;
}

export function ImageAttachButton({ disabled = false }: ImageAttachButtonProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const { attach, isPreparing } = useImageAttach();
  const count = useAttachmentsStore((state) => state.images.length);
  const full = count >= MAX_ATTACHMENTS;

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const { files } = event.target;
    void attach(files);
    // Reset so re-picking the same file fires `change` again — without this,
    // attaching a file, removing it, and re-attaching it silently does nothing.
    event.target.value = '';
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={onChange}
        data-testid="image-attach-input"
      />
      <Tooltip
        content={full ? `Up to ${String(MAX_ATTACHMENTS)} images` : 'Attach an image'}
        relationship="label"
      >
        <Button
          appearance="subtle"
          size="small"
          icon={isPreparing ? <Spinner size="tiny" /> : <ImageAddRegular />}
          disabled={disabled || isPreparing || full}
          onClick={() => inputRef.current?.click()}
          aria-label="Attach an image"
        />
      </Tooltip>
    </>
  );
}
