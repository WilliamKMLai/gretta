/**
 * Rasterising a region of a PDF page (DECISIONS.md ADR-036).
 *
 * Scientific figures are overwhelmingly *vector* — matplotlib, Illustrator,
 * TikZ — so there is usually no embedded image to extract. The only way to see
 * one is to draw it, which is why the companion takes a canvas dependency at
 * all. `@napi-rs/canvas` ships prebuilt binaries (no node-gyp) and drives
 * pdf.js's renderer directly with no DOMMatrix/Path2D shims, verified against
 * real papers before this was written.
 *
 * The crop is the point. A full journal page downscaled to what a vision model
 * actually looks at makes 8pt axis labels unreadable — and axis labels are
 * most of what distinguishes one plot from another. Rendering just the figure's
 * band spends the whole resolution budget on the figure.
 */
import { createCanvas } from '@napi-rs/canvas';
import type { Rect } from './figures.mts';

/** Longest edge of a rendered figure, in pixels. */
export const TARGET_LONG_EDGE_PX = 1400;

/**
 * Ceiling on the scale factor.
 *
 * A small region — a one-line table, a tiny inset — would otherwise be blown up
 * to 1400px, which invents no detail and costs real bytes. Beyond about 4x the
 * page's natural size there is nothing further to resolve.
 */
const MAX_SCALE = 4;

/** A rendered figure, ready to store. */
export interface RenderedFigure {
  mediaType: 'image/png';
  bytes: Buffer;
  width: number;
  height: number;
}

/** The pdf.js page surface this module needs; narrowed so tests can fake it. */
export interface RenderablePage {
  getViewport(options: { scale: number; offsetX?: number; offsetY?: number }): {
    width: number;
    height: number;
  };
  render(options: { canvas: unknown; canvasContext: unknown; viewport: unknown }): {
    promise: Promise<void>;
  };
}

/** Scale that lands `region`'s long edge near the target, capped. */
export function scaleForRegion(region: Rect, targetPx = TARGET_LONG_EDGE_PX): number {
  const longest = Math.max(region.x1 - region.x0, region.y1 - region.y0);
  if (longest <= 0) return 1;
  return Math.min(MAX_SCALE, targetPx / longest);
}

/**
 * Offsets that put a region's top-left corner at the canvas origin.
 *
 * The one piece of arithmetic here worth stating explicitly, because getting it
 * wrong produces a *blank image rather than an error* — which is exactly what
 * happened during development, and only looking at the output caught it.
 *
 * PDF user space has its origin bottom-left with y increasing upward; canvas
 * device space has it top-left with y increasing downward. pdf.js maps a point
 * (x, y) to (x·s + offsetX, (pageHeight − y)·s + offsetY). Setting the region's
 * top-left (x0, y1) to (0, 0) gives the offsets below.
 */
export function cropOffsets(
  region: Rect,
  pageHeight: number,
  scale: number,
): { offsetX: number; offsetY: number } {
  return {
    offsetX: -region.x0 * scale,
    offsetY: -(pageHeight - region.y1) * scale,
  };
}

/**
 * Renders one region of a page to a PNG.
 *
 * The canvas is filled white first: PDF pages have no background of their own,
 * and an unfilled canvas is transparent, which a vision model receives as
 * black — turning every figure into a negative of itself.
 */
export async function renderRegion(
  page: RenderablePage,
  region: Rect,
  pageHeight: number,
): Promise<RenderedFigure> {
  const scale = scaleForRegion(region);
  const width = Math.max(1, Math.ceil((region.x1 - region.x0) * scale));
  const height = Math.max(1, Math.ceil((region.y1 - region.y0) * scale));

  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = 'white';
  context.fillRect(0, 0, width, height);

  const viewport = page.getViewport({ scale, ...cropOffsets(region, pageHeight, scale) });
  await page.render({ canvas, canvasContext: context, viewport }).promise;

  return { mediaType: 'image/png', bytes: canvas.toBuffer('image/png'), width, height };
}
