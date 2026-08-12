/**
 * Staged attachments (ADR-034, and the ADR-035 amendment's dedupe).
 *
 * The rule these protect: the automatic selection path re-reads the selection
 * on every Generate, and a cancelled run deliberately keeps its attachments to
 * retry with. Without dedupe those two facts stack a fresh copy of the same
 * figure on every attempt.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_ATTACHMENTS, useAttachmentsStore } from './attachments.store';
import type { PreparedImage } from './images';

const image = (id: string, dataBase64 = id): PreparedImage => ({
  id,
  name: `${id}.png`,
  dataBase64,
  width: 100,
  height: 100,
  bytes: 100,
});

beforeEach(() => {
  useAttachmentsStore.getState().clear();
});

describe('useAttachmentsStore', () => {
  it('stages images in order', () => {
    useAttachmentsStore.getState().add([image('a'), image('b')]);
    expect(useAttachmentsStore.getState().images.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('treats identical bytes as already staged', () => {
    useAttachmentsStore.getState().add([image('first', 'SAMEBYTES')]);
    const result = useAttachmentsStore.getState().add([image('second', 'SAMEBYTES')]);
    expect(useAttachmentsStore.getState().images.map((i) => i.id)).toEqual(['first']);
    // Not "rejected": the image the user wanted attached is attached, so this
    // must not raise a "too many images" message.
    expect(result.rejected).toBe(0);
  });

  it('still stages a genuinely different image alongside a duplicate', () => {
    useAttachmentsStore.getState().add([image('a', 'AAA')]);
    useAttachmentsStore.getState().add([image('a-again', 'AAA'), image('b', 'BBB')]);
    expect(useAttachmentsStore.getState().images.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('caps at MAX_ATTACHMENTS and reports what would not fit', () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) => image(`i${String(i)}`));
    const result = useAttachmentsStore.getState().add(many);
    expect(useAttachmentsStore.getState().images).toHaveLength(MAX_ATTACHMENTS);
    expect(result.rejected).toBe(2);
  });

  it('refuses everything once full', () => {
    const many = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => image(`i${String(i)}`));
    useAttachmentsStore.getState().add(many);
    expect(useAttachmentsStore.getState().add([image('extra')]).rejected).toBe(1);
  });

  it('removes by id and clears', () => {
    useAttachmentsStore.getState().add([image('a'), image('b')]);
    useAttachmentsStore.getState().remove('a');
    expect(useAttachmentsStore.getState().images.map((i) => i.id)).toEqual(['b']);
    useAttachmentsStore.getState().clear();
    expect(useAttachmentsStore.getState().images).toEqual([]);
  });
});
