/**
 * Finding figures in a PDF by their captions (DECISIONS.md ADR-036).
 *
 * A figure has no marker in a PDF. There is no "figure" object to enumerate —
 * a plot is just drawing operators, and in most scientific papers those are
 * vector paths rather than an embedded image, so there is nothing to extract
 * either. What a figure reliably *does* have is a caption: a line of text
 * starting "Figure 3." or "Table 1:" sitting immediately next to it.
 *
 * So captions are the anchor. They give the page, the column, the text a
 * reader would search for, and — through the whitespace around them — the
 * region worth rendering.
 *
 * Everything here is pure: it takes positioned text and page dimensions and
 * returns geometry. Rendering lives in render.mts, so this can be tested
 * against real papers without a canvas.
 *
 * Coordinates are PDF user space throughout: origin bottom-left, y increasing
 * upward. pdf.js reports each text item's baseline in `transform[4]`/`[5]`.
 */

/** One positioned text run, as pdf.js reports it. */
export interface TextItem {
  str: string;
  /** [a, b, c, d, e, f] — e is x, f is the baseline y. */
  transform: number[];
  width: number;
  height: number;
}

/** A rectangle in PDF user space. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Text items merged into one visual line. */
export interface TextLine {
  text: string;
  box: Rect;
}

/** A caption and the region it labels. */
export interface FigureAnchor {
  /** 1-based page. */
  page: number;
  /** `figure` or `table` — decides which side of the caption to look on. */
  kind: 'figure' | 'table';
  /** Caption text, as a reader would search for it. */
  caption: string;
  /** The region to render. */
  region: Rect;
  /** True when the region fell back to (most of) the page. */
  isFallback: boolean;
}

/**
 * Caption openers, tolerant of the real variety: "Fig. 2", "Figure 3:",
 * "Extended Data Fig. 1", "Supplementary Figure 4", "Table 1".
 *
 * Anchoring at the start of a line is necessary but nowhere near sufficient.
 * Body text wraps, and a wrapped line lands on a figure reference constantly —
 * measured across 22 real papers, in-text references starting a line were the
 * single largest source of phantom figures ("Figure 1 shows the prediction…",
 * "Table 1). Therefore…", "Fig. 4a-b). Based on…").
 *
 * The panel-range group is load-bearing: without it "Fig. 4a-b)." leaves a
 * remainder starting with `-`, which passes every other test.
 */
const CAPTION_OPENER =
  /^(?:(?:extended\s+data|supplementary|supplemental|supp\.?)\s+)?(fig(?:ure|s)?\.?|table|scheme|chart)\s*\.?\s*(?:s\s*)?\d+\s*(?:[a-z]{1,3}(?:\s*[–—-]\s*[a-z]{1,3})?(?![A-Za-z]))?/iu;

/** Separators that legitimately follow a caption's number. */
const CAPTION_SEPARATORS = /^[.:|–—\s]+/u;

/**
 * Distinguishes a caption from a sentence that merely starts with one.
 *
 * A real caption is followed by a separator and a title — "Fig. 1 | AlphaFold
 * produces…", "Figure 2. Definition of aligned error…", "Table 1 Success
 * rate…". A reference continues the sentence: a lowercase verb ("shows",
 * "for", "highlights"), or a bracket closing the citation ("Table 1).",
 * "Fig. 1A (see methods)").
 */
export function looksLikeCaption(text: string): boolean {
  // Journals put a decorative rule before the caption and some render it as a
  // literal glyph — Nature Reviews emits "|Figure 1 Cryo-EM timeline." — which
  // defeats an anchored match. Leading non-alphanumerics are stripped first.
  const cleaned = text.replace(/^[^\p{L}\p{N}]+/u, '');
  const match = CAPTION_OPENER.exec(cleaned);
  if (match === null) return false;

  const rest = cleaned.slice(match[0].length);
  const trimmed = rest.trimStart();
  // "Table 1)." / "Fig. 1A (see methods" — the number is part of a sentence.
  if (trimmed.startsWith(')') || trimmed.startsWith('(')) return false;

  const title = trimmed.replace(CAPTION_SEPARATORS, '');
  // A caption whose title wrapped to the next line is still a caption.
  if (title === '') return true;
  // "Figure 1 shows…", "Fig. 14 for all-atom accuracy" — mid-sentence.
  return !/^\p{Ll}/u.test(title);
}

/** Lines this short are numbering or axis labels, not captions. */
const MIN_CAPTION_CHARS = 12;

/** A gap smaller than this (as a fraction of page height) is line spacing. */
const MIN_GAP_FRACTION = 0.04;

/** Below this fraction of page height, a band is too thin to be the figure. */
const MIN_BAND_FRACTION = 0.08;

/**
 * Above this fraction, the band is the page in all but name.
 *
 * Measured: a table captioned at the top of a page with prose beneath it found
 * no gap to stop at and ran to the page edge — 739pt of a 792pt page, reported
 * as a successful crop. Rendering is identical either way, so this changes no
 * pixels; it makes `isFallback` mean what it says, which is what the fallback
 * rate is read as when judging whether the geometry works.
 */
const MAX_BAND_FRACTION = 0.85;

/** Items whose baselines differ by less than this are the same line. */
const LINE_TOLERANCE_PT = 3;

function itemBox(item: TextItem): Rect {
  const x = item.transform[4] ?? 0;
  const y = item.transform[5] ?? 0;
  return { x0: x, y0: y, x1: x + item.width, y1: y + item.height };
}

function union(a: Rect, b: Rect): Rect {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/** True when two rectangles share horizontal extent — i.e. the same column. */
function overlapsHorizontally(a: Rect, b: Rect, minOverlapPt = 8): boolean {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > minOverlapPt;
}

/**
 * Merges positioned runs into visual lines.
 *
 * pdf.js splits a line wherever the font, size, or spacing changes, so
 * "Figure" and "3." routinely arrive as separate items and a caption test
 * applied per item would never match. Grouping by baseline reassembles them.
 */
export function groupLines(items: readonly TextItem[]): TextLine[] {
  const withBoxes = items
    .filter((item) => item.str.trim() !== '')
    .map((item) => ({ item, box: itemBox(item) }))
    .sort((a, b) => b.box.y0 - a.box.y0 || a.box.x0 - b.box.x0);

  const lines: TextLine[] = [];
  let current: { text: string; box: Rect } | null = null;
  let baseline = Number.NaN;

  for (const { item, box } of withBoxes) {
    if (current === null || Math.abs(box.y0 - baseline) > LINE_TOLERANCE_PT) {
      if (current !== null) lines.push(current);
      current = { text: item.str, box };
      baseline = box.y0;
      continue;
    }
    // Re-insert a space pdf.js dropped between adjacent runs.
    const gap = box.x0 - current.box.x1;
    current.text += gap > 1 && !current.text.endsWith(' ') ? ` ${item.str}` : item.str;
    current.box = union(current.box, box);
  }
  if (current !== null) lines.push(current);
  return lines;
}

/** Classifies a caption opener; tables are captioned above, figures below. */
function captionKind(text: string): 'figure' | 'table' {
  return /table/iu.test(text.slice(0, 24)) ? 'table' : 'figure';
}

/**
 * The region a caption labels.
 *
 * Figures sit above their caption and tables below it, so the search runs in
 * that direction and stops at the first substantial band of whitespace — the
 * gutter between the caption and whatever text lies beyond the figure.
 *
 * Only lines sharing horizontal extent with the caption are considered, which
 * is what makes two-column papers work: the adjacent column is full of text at
 * the same heights, and counting it would collapse every band to nothing.
 */
export function figureRegion(
  caption: TextLine,
  lines: readonly TextLine[],
  pageWidth: number,
  pageHeight: number,
): { region: Rect; isFallback: boolean } {
  const kind = captionKind(caption.text);
  const sameColumn = lines.filter(
    (line) => line !== caption && overlapsHorizontally(line.box, caption.box),
  );

  // The column's own width, so a region is not clipped to the caption's
  // longest line — figures routinely overhang their caption slightly.
  const columnBox = sameColumn.reduce<Rect>((acc, line) => union(acc, line.box), caption.box);
  const x0 = Math.max(0, columnBox.x0 - 4);
  const x1 = Math.min(pageWidth, columnBox.x1 + 4);

  const minGap = pageHeight * MIN_GAP_FRACTION;

  if (kind === 'figure') {
    const above = sameColumn
      .filter((line) => line.box.y0 > caption.box.y1)
      .sort((a, b) => a.box.y0 - b.box.y0);
    const edge = walkToGap(caption.box.y1, above, minGap, pageHeight, 'up');
    return finish({ x0, y0: caption.box.y1 + 1, x1, y1: edge }, pageWidth, pageHeight);
  }

  const below = sameColumn
    .filter((line) => line.box.y1 < caption.box.y0)
    .sort((a, b) => b.box.y1 - a.box.y1);
  const edge = walkToGap(caption.box.y0, below, minGap, 0, 'down');
  return finish({ x0, y0: edge, x1, y1: caption.box.y0 - 1 }, pageWidth, pageHeight);
}

/**
 * Walks away from the caption to the first substantial band of whitespace.
 *
 * The obvious version — "find the first line far from the caption" — is wrong,
 * and measurably so: it produced a full-page fallback on 53% of real figures.
 * Figures *contain* text. Axis labels, panel letters, and legends are all text
 * lines sitting inside the figure, and any of them can be far enough from the
 * caption to look like the boundary while being nowhere near it.
 *
 * The gap that matters is between *consecutive* lines, not between a line and
 * the caption. Lines are absorbed one at a time — they are part of the figure —
 * until two of them are separated by more than `minGap`, which is the gutter
 * before the surrounding body text.
 */
function walkToGap(
  start: number,
  lines: readonly TextLine[],
  minGap: number,
  limit: number,
  direction: 'up' | 'down',
): number {
  let frontier = start;
  for (const line of lines) {
    const near = direction === 'up' ? line.box.y0 : line.box.y1;
    const far = direction === 'up' ? line.box.y1 : line.box.y0;
    const gap = direction === 'up' ? near - frontier : frontier - near;
    if (gap > minGap) return direction === 'up' ? near - 2 : near + 2;
    frontier = far;
  }
  return limit;
}

/**
 * Accepts a band, or falls back to the whole page.
 *
 * A band thinner than `MIN_BAND_FRACTION` means the geometry found nothing
 * plausible — a caption with body text immediately above it, a figure on the
 * previous page, a layout this heuristic does not understand. Rendering that
 * sliver would send the model a strip of whitespace, which is worse than
 * sending the whole page and letting it find the figure itself.
 */
function finish(
  region: Rect,
  pageWidth: number,
  pageHeight: number,
): {
  region: Rect;
  isFallback: boolean;
} {
  const height = region.y1 - region.y0;
  const width = region.x1 - region.x0;
  const tooThin = height < pageHeight * MIN_BAND_FRACTION;
  const tooTall = height > pageHeight * MAX_BAND_FRACTION;
  if (tooThin || tooTall || width <= 0) {
    return { region: { x0: 0, y0: 0, x1: pageWidth, y1: pageHeight }, isFallback: true };
  }
  return { region, isFallback: false };
}

/** Every figure/table caption on one page, with the region each labels. */
export function findFigures(
  items: readonly TextItem[],
  page: number,
  pageWidth: number,
  pageHeight: number,
): FigureAnchor[] {
  const lines = groupLines(items);
  const anchors: FigureAnchor[] = [];

  for (const line of lines) {
    const text = line.text.trim();
    if (text.length < MIN_CAPTION_CHARS) continue;
    if (!looksLikeCaption(text)) continue;

    const { region, isFallback } = figureRegion(line, lines, pageWidth, pageHeight);
    anchors.push({ page, kind: captionKind(text), caption: text, region, isFallback });
  }
  return anchors;
}

/** Stable id for a figure, so a re-index of an unchanged file reuses its work. */
export function figureId(contentHash: string, page: number, region: Rect): string {
  const box = [region.x0, region.y0, region.x1, region.y1].map(Math.round).join('_');
  return `${contentHash}-p${String(page)}-${box}`;
}
