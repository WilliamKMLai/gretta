/**
 * Caption detection and figure geometry (ADR-036).
 *
 * Every accept/reject case below is a real line lifted from the 22-paper
 * corpus this was tuned against (Nature, Science, PNAS, NAR, EMBO, bioRxiv,
 * arXiv). The papers cannot be committed, so the strings they taught are.
 *
 * Two of these encode measured regressions rather than hypotheticals:
 *  - in-text references starting a wrapped line were the single largest source
 *    of phantom figures before `looksLikeCaption` existed;
 *  - the case-insensitive panel-letter group silently ate the first three
 *    characters of a title ("Figure 1 Overview" -> panel "Ove"), taking two
 *    whole papers from 11 detections to zero.
 */
import { describe, expect, it } from 'vitest';
import { figureId, figureRegion, findFigures, groupLines, looksLikeCaption } from './figures.mts';
import type { TextItem, TextLine } from './figures.mts';

/** A text item at a PDF baseline (origin bottom-left, y up). */
const item = (
  str: string,
  x: number,
  y: number,
  width = str.length * 5,
  height = 10,
): TextItem => ({
  str,
  transform: [1, 0, 0, 1, x, y],
  width,
  height,
});

const line = (text: string, x0: number, y0: number, x1 = x0 + 200, y1 = y0 + 10): TextLine => ({
  text,
  box: { x0, y0, x1, y1 },
});

describe('looksLikeCaption', () => {
  it.each([
    'Figure 1: Boltz-2 presents a strong accuracy profile',
    'Figure 2. Definition of aligned error (AE) in AlphaFold2',
    'Fig. 1 | AlphaFold produces highly accurate structures.',
    'Fig 1. Distribution of DockQ score for Incorrect, Acceptable',
    'Figure 1 Overview of the Chai-1 model architecture and input features.',
    'Table 1 Success rate of different modelling setups.',
    'Extended Data Fig. 1 | Model architecture details.',
    'Supplementary Figure 4: Additional benchmarks.',
    '|Figure 1 Cryo-EM timeline. Selected key events in the development',
  ])('accepts a real caption: %s', (text) => {
    expect(looksLikeCaption(text)).toBe(true);
  });

  it.each([
    'Figure 1 shows the AlphaFold prediction, the position of each amino acid',
    'Figure 1a highlights the similarities between RF structure prediction',
    'Table 1). Therefore, combining AF2 and paired MSAs improves',
    'Fig. 4a-b). Based on these observations, we specified the secondary',
    'Figure 3K). Thus ProteinMPNN can robustly design sequences',
    'Fig. 1A (see methods and fig. S1 for details).',
    'Fig. 14 for all-atom accuracy). As a comparison point',
    'Supplementary Table 1 for a comparison of all designs in the paper',
  ])('rejects an in-text reference: %s', (text) => {
    expect(looksLikeCaption(text)).toBe(false);
  });

  it('ignores prose that merely mentions a figure mid-sentence', () => {
    expect(looksLikeCaption('as shown in Figure 3, the trend reverses')).toBe(false);
  });
});

describe('groupLines', () => {
  it('reassembles runs pdf.js split mid-caption', () => {
    // "Figure" and "1." routinely arrive as separate items, so a per-item
    // caption test would never match anything.
    const lines = groupLines([item('Figure', 100, 400, 32), item('1.', 134, 400, 10)]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Figure 1.');
  });

  it('keeps separate baselines apart', () => {
    const lines = groupLines([item('second', 100, 380), item('first', 100, 400)]);
    expect(lines.map((l) => l.text)).toEqual(['first', 'second']);
  });

  it('re-inserts a space the parser dropped between runs', () => {
    const lines = groupLines([item('Tumor', 100, 400, 30), item('volume', 140, 400, 30)]);
    expect(lines[0]?.text).toBe('Tumor volume');
  });

  it('drops whitespace-only runs', () => {
    expect(groupLines([item('   ', 100, 400)])).toEqual([]);
  });
});

describe('figureRegion', () => {
  const PAGE_W = 612;
  const PAGE_H = 792;

  it('spans the whitespace above a figure caption', () => {
    const caption = line('Figure 1. A plot of something', 72, 300);
    const body = line('Body text well above the figure', 72, 700);
    const { region, isFallback } = figureRegion(caption, [caption, body], PAGE_W, PAGE_H);
    expect(isFallback).toBe(false);
    expect(region.y0).toBeGreaterThan(caption.box.y1 - 1);
    expect(region.y1).toBeLessThan(body.box.y0);
    expect(region.y1 - region.y0).toBeGreaterThan(300);
  });

  it('absorbs axis labels inside the figure instead of stopping at them', () => {
    // The measured bug: figures contain text, and treating any distant line as
    // the boundary produced a full-page fallback on 53% of real figures.
    // Spacing matters here: figure-internal text sits close to what surrounds
    // it (a caption is tucked right under the artwork), while the gutter before
    // the body text above is large. Those two distances are the whole signal.
    const caption = line('Figure 1. A plot', 72, 300);
    const axisLabel = line('0.5', 200, 322, 220, 330);
    const panelLetter = line('a', 80, 348, 88, 358);
    const body = line('Body text above the figure', 72, 700);
    const { region, isFallback } = figureRegion(
      caption,
      [caption, axisLabel, panelLetter, body],
      PAGE_W,
      PAGE_H,
    );
    expect(isFallback).toBe(false);
    // Both in-figure labels must be inside the region, not act as its ceiling.
    expect(region.y1).toBeGreaterThan(panelLetter.box.y1);
  });

  it('searches below the caption for a table', () => {
    const caption = line('Table 1. Benchmarks', 72, 600);
    const body = line('Body text below the table', 72, 200);
    const { region } = figureRegion(caption, [caption, body], PAGE_W, PAGE_H);
    expect(region.y1).toBeLessThan(caption.box.y0);
    expect(region.y0).toBeGreaterThan(body.box.y1);
  });

  it('ignores the adjacent column in a two-column layout', () => {
    // Without the horizontal-overlap filter the neighbouring column's text sits
    // at every height and collapses every band to nothing.
    const caption = line('Figure 1. Left column figure', 60, 300, 290, 310);
    const otherColumn = line('Dense text in the right column', 320, 500, 550, 510);
    const body = line('Body above, same column', 60, 700, 290, 710);
    const { region, isFallback } = figureRegion(
      caption,
      [caption, otherColumn, body],
      PAGE_W,
      PAGE_H,
    );
    expect(isFallback).toBe(false);
    expect(region.x1).toBeLessThan(320);
  });

  it('falls back to the page when the band is too thin to be a figure', () => {
    // Body text immediately above the caption: the figure is elsewhere, and a
    // sliver of whitespace is worse to send than the whole page.
    const caption = line('Figure 1. Something', 72, 300);
    // Far enough to end the walk, too close to leave room for a figure.
    const justAbove = line('Text right above', 72, 350);
    const { region, isFallback } = figureRegion(caption, [caption, justAbove], PAGE_W, PAGE_H);
    expect(isFallback).toBe(true);
    expect(region).toEqual({ x0: 0, y0: 0, x1: PAGE_W, y1: PAGE_H });
  });

  it('falls back when the band is the page in all but name', () => {
    // A table captioned at the top of a page with prose beneath found no gap
    // and ran to the page edge — 739pt of 792pt, reported as a crop.
    const caption = line('Table 1. Benchmarks', 72, 760);
    const { region, isFallback } = figureRegion(caption, [caption], PAGE_W, PAGE_H);
    expect(isFallback).toBe(true);
    expect(region.y1 - region.y0).toBe(PAGE_H);
  });
});

describe('findFigures', () => {
  it('finds a caption and its region on a page', () => {
    const items = [
      ...['Body', 'text', 'above'].map((s, i) => item(s, 72 + i * 30, 700)),
      item('Figure', 72, 300, 32),
      item('1.', 106, 300, 10),
      item('A synthetic plot of results', 120, 300, 130),
    ];
    const found = findFigures(items, 3, 612, 792);
    expect(found).toHaveLength(1);
    expect(found[0]?.page).toBe(3);
    expect(found[0]?.kind).toBe('figure');
    expect(found[0]?.caption).toContain('Figure 1.');
  });

  it('finds nothing on a page of prose', () => {
    const items = ['This', 'page', 'has', 'no', 'figures'].map((s, i) => item(s, 72 + i * 30, 700));
    expect(findFigures(items, 1, 612, 792)).toEqual([]);
  });

  it('classifies a table caption as a table', () => {
    const items = [item('Table 1. Benchmark results for every model', 72, 600, 200)];
    expect(findFigures(items, 1, 612, 792)[0]?.kind).toBe('table');
  });
});

describe('figureId', () => {
  it('is stable for the same file, page, and region', () => {
    const region = { x0: 10.2, y0: 20.4, x1: 300.6, y1: 400.9 };
    expect(figureId('abc123', 4, region)).toBe(figureId('abc123', 4, { ...region }));
  });

  it('changes when the file content changes', () => {
    // The cache key: an edited file must not reuse a description of the old
    // figure, while an unchanged one keeps work that cost 16 seconds.
    const region = { x0: 10, y0: 20, x1: 300, y1: 400 };
    expect(figureId('abc123', 4, region)).not.toBe(figureId('def456', 4, region));
  });

  it('separates two figures on one page', () => {
    expect(figureId('abc', 4, { x0: 0, y0: 0, x1: 100, y1: 100 })).not.toBe(
      figureId('abc', 4, { x0: 0, y0: 200, x1: 100, y1: 300 }),
    );
  });
});
