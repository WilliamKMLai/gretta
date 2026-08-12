/**
 * Turning a user-supplied file into something worth sending (ADR-034).
 *
 * Every image entering GRETTA goes through `prepareImage`, whatever door it came
 * in by — attach, paste, drop, or the Word document. Normalising at one point
 * means the downscale, the re-encode, and the size ceiling cannot be skipped by
 * adding a fifth door later.
 *
 * Why downscale at all: vision models tile at roughly 1120px and downscale
 * anything larger before they look at it, so pixels above that ceiling cost
 * tokens and latency and buy no detail. A phone photo pasted at full size is
 * ~20 MB of base64 crossing loopback for nothing.
 *
 * Re-encoding also drops EXIF, so a photographed whiteboard doesn't carry GPS
 * coordinates into a request. Incidental to the purpose, but the right default
 * for a project whose premise is that nothing leaves the machine.
 *
 * PNG is the output format because the subject is overwhelmingly line art —
 * plots, diagrams, panels — where PNG is both smaller and lossless, and where
 * JPEG's ringing lands exactly on the thin strokes and small type a reader needs
 * to make out. Photographs pay for that, and it is the right trade here.
 */

/** Longest edge, in pixels, of an image that reaches the model. */
export const MAX_IMAGE_EDGE_PX = 1400;

/** Rejected above this, before decoding — a guard against a pathological file. */
export const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

/** An image ready to attach: base64 with no `data:` prefix, as Ollama wants. */
export interface PreparedImage {
  id: string;
  /** Display name for the chip; the original filename when there was one. */
  name: string;
  /** Base64 payload, no data-URI prefix (ADR-034 / Ollama's `images` field). */
  dataBase64: string;
  width: number;
  height: number;
  /** Rendered size in bytes, for the "too large" readout. */
  bytes: number;
}

export type PrepareImageResult = { ok: true; image: PreparedImage } | { ok: false; reason: string };

/** Target dimensions that fit `MAX_IMAGE_EDGE_PX`, preserving aspect ratio. */
export function scaleToFit(
  width: number,
  height: number,
  maxEdge = MAX_IMAGE_EDGE_PX,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const ratio = maxEdge / longest;
  // Never round down to zero: a 4000x1 banner is degenerate but not an error.
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/**
 * Base64 → Blob, so the Word-document path (ADR-035) enters the same funnel.
 *
 * That route already has bytes rather than a `File`, and it would be easy to
 * hand them straight to the model. It must not: the downscale, the re-encode,
 * and the size ceiling all live in `prepareImage`, and a fourth door that
 * bypassed them is exactly the drift this module exists to prevent.
 *
 * Returns null on a payload that is not valid base64 rather than throwing —
 * malformed bytes from a document are a thing to report, not an exception.
 */
export function base64ToBlob(dataBase64: string, mediaType: string): Blob | null {
  try {
    const binary = atob(stripDataUrlPrefix(dataBase64));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mediaType });
  } catch {
    return null;
  }
}

/** Strips a `data:image/png;base64,` prefix if present; Ollama wants raw base64. */
export function stripDataUrlPrefix(value: string): string {
  const comma = value.indexOf(',');
  return value.startsWith('data:') && comma !== -1 ? value.slice(comma + 1) : value;
}

/**
 * Decodes, downscales, and re-encodes one image.
 *
 * Returns a typed reason rather than throwing, matching how the companion's
 * parsers report an unreadable file: a dropped image is something to explain in
 * the UI, not an exception to bubble through a click handler.
 */
export async function prepareImage(file: Blob, name: string): Promise<PrepareImageResult> {
  if (file.size > MAX_SOURCE_BYTES) {
    return { ok: false, reason: `${name} is too large to send (over 40 MB).` };
  }
  if (!file.type.startsWith('image/')) {
    return { ok: false, reason: `${name} is not an image.` };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: `${name} could not be read as an image.` };
  }

  try {
    const { width, height } = scaleToFit(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) return { ok: false, reason: 'This browser could not process the image.' };
    context.drawImage(bitmap, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/png');
    const dataBase64 = stripDataUrlPrefix(dataUrl);
    if (dataBase64 === '') return { ok: false, reason: `${name} could not be encoded.` };

    return {
      ok: true,
      image: {
        id: `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        dataBase64,
        width,
        height,
        // base64 is 4 characters per 3 bytes; close enough for a size readout.
        bytes: Math.floor((dataBase64.length * 3) / 4),
      },
    };
  } finally {
    bitmap.close();
  }
}
