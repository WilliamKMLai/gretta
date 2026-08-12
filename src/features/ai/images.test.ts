/**
 * Image preparation (ADR-034).
 *
 * `prepareImage` itself needs canvas and `createImageBitmap`, neither of which
 * jsdom provides, so it is verified live in Word. The two pure decisions it
 * delegates to — how far to scale down, and how to strip a data-URI prefix —
 * are the parts that would silently send the wrong bytes, so they are tested
 * here.
 */
import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_EDGE_PX, scaleToFit, stripDataUrlPrefix } from './images';

describe('scaleToFit', () => {
  it('leaves an image that already fits completely alone', () => {
    expect(scaleToFit(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('does not upscale a small image to the ceiling', () => {
    expect(scaleToFit(64, 64)).toEqual({ width: 64, height: 64 });
  });

  it('caps the long edge and preserves the aspect ratio', () => {
    const { width, height } = scaleToFit(4000, 2000);
    expect(width).toBe(MAX_IMAGE_EDGE_PX);
    expect(height).toBe(MAX_IMAGE_EDGE_PX / 2);
  });

  it('caps the long edge when the image is portrait', () => {
    const { width, height } = scaleToFit(1000, 5000);
    expect(height).toBe(MAX_IMAGE_EDGE_PX);
    expect(width).toBe(280);
  });

  it('never rounds a degenerate edge down to zero', () => {
    // A 4000x1 banner is odd but not an error; a zero-width canvas is.
    const { width, height } = scaleToFit(4000, 1);
    expect(width).toBe(MAX_IMAGE_EDGE_PX);
    expect(height).toBe(1);
  });

  it('treats an image exactly at the ceiling as fitting', () => {
    const square = scaleToFit(MAX_IMAGE_EDGE_PX, MAX_IMAGE_EDGE_PX);
    expect(square).toEqual({ width: MAX_IMAGE_EDGE_PX, height: MAX_IMAGE_EDGE_PX });
  });
});

describe('stripDataUrlPrefix', () => {
  it('removes a data-URI prefix, because Ollama wants raw base64', () => {
    expect(stripDataUrlPrefix('data:image/png;base64,AAAB')).toBe('AAAB');
  });

  it('leaves bare base64 untouched', () => {
    expect(stripDataUrlPrefix('AAAB')).toBe('AAAB');
  });

  it('does not cut at a comma in a payload that is not a data URI', () => {
    expect(stripDataUrlPrefix('AA,AB')).toBe('AA,AB');
  });
});
