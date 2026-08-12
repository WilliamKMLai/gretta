/**
 * Images staged for the next run (ADR-034; colocated store per ADR-005).
 *
 * Deliberately NOT persisted. Every other store in this feature survives a
 * reload; this one must not. An attachment is part of one question, and a
 * stale image silently riding along on tomorrow's unrelated prompt is both a
 * confusing answer and a privacy surprise — the pane would be sending a picture
 * the user has forgotten is there. Local storage is also the wrong size of box
 * for a few megabytes of base64.
 *
 * Cleared on a completed run rather than at submit, so a cancelled or failed
 * generation leaves the attachments in place to retry with.
 */
import { create } from 'zustand';
import type { PreparedImage } from './images';

/** Hard cap on staged images. */
export const MAX_ATTACHMENTS = 4;

export interface AttachmentsState {
  images: PreparedImage[];
  /** Appends up to the cap; returns what was refused, for the caller to report. */
  add: (images: PreparedImage[]) => { rejected: number };
  remove: (id: string) => void;
  clear: () => void;
}

export const useAttachmentsStore = create<AttachmentsState>()((set, get) => ({
  images: [],

  add: (incoming) => {
    /*
     * Identical bytes are treated as already staged.
     *
     * The automatic selection path (ADR-035 amendment) re-reads the selection
     * on every Generate, so a run that was cancelled or failed — which
     * deliberately keeps its attachments for the retry — would otherwise stack
     * a second copy of the same figure on each attempt. Also quietly fixes
     * pasting the same image twice.
     */
    const existing = new Set(get().images.map((image) => image.dataBase64));
    const fresh = incoming.filter((image) => !existing.has(image.dataBase64));
    const duplicates = incoming.length - fresh.length;

    const room = MAX_ATTACHMENTS - get().images.length;
    if (room <= 0) return { rejected: fresh.length };
    const accepted = fresh.slice(0, room);
    if (accepted.length > 0) set((state) => ({ images: [...state.images, ...accepted] }));
    // Duplicates are not "rejected" in the sense worth reporting — the image
    // the user wanted attached is attached.
    return { rejected: incoming.length - accepted.length - duplicates };
  },

  remove: (id) => {
    set((state) => ({ images: state.images.filter((image) => image.id !== id) }));
  },

  clear: () => {
    set({ images: [] });
  },
}));
