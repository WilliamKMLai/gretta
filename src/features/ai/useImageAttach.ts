/**
 * The one way an image gets staged (ADR-034).
 *
 * Four doors — attach, paste, drop, and (later) the Word document — but one
 * path behind them. Each door only has to produce `File`/`Blob` objects; the
 * ceiling, the downscale, the re-encode, and the error reporting all happen
 * here. Duplicating that per door is how one of them ends up quietly skipping
 * the size cap.
 *
 * Rejections are reported per batch rather than per file: dropping a folder of
 * twelve PDFs onto the prompt box should say one thing, not twelve.
 */
import { useCallback, useState } from 'react';
import { useAppToasts } from '../../components/toaster';
import { getServices } from '../../app/services';
import { describeUndecodable } from '../../services/office';
import { MAX_ATTACHMENTS, useAttachmentsStore } from './attachments.store';
import { base64ToBlob, prepareImage, type PreparedImage } from './images';

export interface UseImageAttachResult {
  /** Stages image files, reporting anything refused. Ignores non-images. */
  attach: (files: readonly File[] | FileList | null) => Promise<void>;
  /** Stages images found on a paste/drop DataTransfer, if any. */
  attachFromTransfer: (data: DataTransfer | null) => Promise<boolean>;
  /** Stages the picture(s) in the Word selection (ADR-035). */
  attachFromDocument: () => Promise<void>;
  /**
   * Cheap, silent variant for the automatic path: stages any inline pictures
   * in the selection and says nothing when there are none.
   */
  attachSelectionFigures: () => Promise<void>;
  /** True while decoding — the affordance shows a spinner rather than freezing. */
  isPreparing: boolean;
}

function imageFilesOf(data: DataTransfer): File[] {
  return Array.from(data.files).filter((file) => file.type.startsWith('image/'));
}

export function useImageAttach(): UseImageAttachResult {
  const toasts = useAppToasts();
  const [isPreparing, setIsPreparing] = useState(false);

  const attach = useCallback(
    async (files: readonly File[] | FileList | null): Promise<void> => {
      const list = files === null ? [] : Array.from(files);
      if (list.length === 0) return;

      setIsPreparing(true);
      try {
        const prepared: PreparedImage[] = [];
        const failures: string[] = [];
        for (const file of list) {
          const result = await prepareImage(file, file.name);
          if (result.ok) prepared.push(result.image);
          else failures.push(result.reason);
        }

        if (prepared.length > 0) {
          const { rejected } = useAttachmentsStore.getState().add(prepared);
          if (rejected > 0) {
            toasts.info(`Only ${String(MAX_ATTACHMENTS)} images can be attached at once.`);
          }
        }
        // One message for the batch; the first reason is representative and a
        // stack of identical toasts is worse than a count.
        if (failures.length === 1) toasts.error(failures[0] ?? '');
        else if (failures.length > 1) {
          toasts.error(`${String(failures.length)} files could not be attached as images.`);
        }
      } finally {
        setIsPreparing(false);
      }
    },
    [toasts],
  );

  const attachFromTransfer = useCallback(
    async (data: DataTransfer | null): Promise<boolean> => {
      if (data === null) return false;
      const images = imageFilesOf(data);
      if (images.length === 0) return false;
      await attach(images);
      return true;
    },
    [attach],
  );

  /*
   * Three distinct "nothing happened" causes, and only one of them is boring
   * (ADR-035). Selecting text with no picture in it deserves a nudge; a figure
   * stored as a Windows metafile deserves the real explanation, because the
   * user is looking straight at a figure GRETTA just declined to read.
   */
  const attachFromDocument = useCallback(async (): Promise<void> => {
    setIsPreparing(true);
    try {
      const { images, undecodable } = await getServices().office.getSelectedImages();
      if (images.length === 0) {
        toasts.info(
          undecodable.length > 0
            ? describeUndecodable(undecodable)
            : 'Select a figure in the document first.',
        );
        return;
      }

      const prepared: PreparedImage[] = [];
      for (const [index, image] of images.entries()) {
        const blob = base64ToBlob(image.dataBase64, image.mediaType);
        if (blob === null) continue;
        const result = await prepareImage(blob, `Figure ${String(index + 1)}`);
        if (result.ok) prepared.push(result.image);
      }
      if (prepared.length === 0) {
        toasts.error('That figure could not be read.');
        return;
      }
      const { rejected } = useAttachmentsStore.getState().add(prepared);
      if (rejected > 0) {
        toasts.info(`Only ${String(MAX_ATTACHMENTS)} images can be attached at once.`);
      }
    } catch (error) {
      toasts.error(
        error instanceof Error ? error.message : 'Could not read the figure from the document.',
      );
    } finally {
      setIsPreparing(false);
    }
  }, [toasts]);

  /*
   * The automatic path (ADR-035 amendment).
   *
   * Runs on Generate when the context chip is "Selection" — the user has
   * already said the selection is what they are pointing at, and a figure
   * inside it is part of that. Uses the cheap inline-picture read, never the
   * OOXML package, because this fires on every such run and the overwhelming
   * majority of selections contain no picture at all.
   *
   * Silent throughout, including on failure. This is a bonus on top of a
   * generation the user asked for; interrupting it with an error about a
   * figure they may not have known was in range would be worse than the
   * text-only answer they are about to get anyway.
   */
  const attachSelectionFigures = useCallback(async (): Promise<void> => {
    let found;
    try {
      found = await getServices().office.getSelectedInlinePictures();
    } catch {
      return;
    }
    if (found.length === 0) return;

    const prepared: PreparedImage[] = [];
    for (const image of found) {
      const blob = base64ToBlob(image.dataBase64, image.mediaType);
      if (blob === null) continue;
      const result = await prepareImage(blob, image.name);
      if (result.ok) prepared.push(result.image);
    }
    if (prepared.length > 0) useAttachmentsStore.getState().add(prepared);
  }, []);

  return { attach, attachFromTransfer, attachFromDocument, attachSelectionFigures, isPreparing };
}
