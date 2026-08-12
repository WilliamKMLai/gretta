/**
 * OOXML image extraction (ADR-035).
 *
 * The rule these protect: a selection containing a picture GRETTA cannot decode
 * must never look the same as a selection containing no picture. The user can
 * see their figure, and "nothing found" would be a lie.
 */
import { describe, expect, it } from 'vitest';
import { describeUndecodable, imagesFromOoxml, isMetafile } from './ooxml';

/** A 1x1 PNG — valid base64, small enough to inline. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function pkg(parts: string): string {
  return `<?xml version="1.0" standalone="yes"?>
<pkg:package xmlns:pkg="http://schemas.microsoft.com/office/2006/xmlPackage">${parts}</pkg:package>`;
}

const imagePart = (name: string, type: string, data: string): string =>
  `<pkg:part pkg:name="${name}" pkg:contentType="${type}" pkg:compression="store"><pkg:binaryData>${data}</pkg:binaryData></pkg:part>`;

const documentPart = `<pkg:part pkg:name="/word/document.xml" pkg:contentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"><pkg:xmlData><w:document/></pkg:xmlData></pkg:part>`;

describe('imagesFromOoxml', () => {
  it('pulls a PNG out of a package alongside non-image parts', () => {
    const scan = imagesFromOoxml(
      pkg(documentPart + imagePart('/word/media/image1.png', 'image/png', PNG_B64)),
    );
    expect(scan.images).toHaveLength(1);
    expect(scan.images[0]?.mediaType).toBe('image/png');
    expect(scan.images[0]?.dataBase64).toBe(PNG_B64);
    expect(scan.images[0]?.name).toBe('/word/media/image1.png');
    expect(scan.undecodable).toEqual([]);
  });

  it('finds every image when the selection holds several', () => {
    const scan = imagesFromOoxml(
      pkg(
        imagePart('/word/media/image1.png', 'image/png', PNG_B64) +
          imagePart('/word/media/image2.jpeg', 'image/jpeg', PNG_B64),
      ),
    );
    expect(scan.images.map((i) => i.mediaType)).toEqual(['image/png', 'image/jpeg']);
  });

  it('strips the line wrapping Word puts in binaryData', () => {
    // Word wraps base64 at column boundaries; atob rejects the whitespace.
    const wrapped = `${PNG_B64.slice(0, 40)}\n      ${PNG_B64.slice(40)}`;
    const scan = imagesFromOoxml(pkg(imagePart('/word/media/i.png', 'image/png', wrapped)));
    expect(scan.images[0]?.dataBase64).toBe(PNG_B64);
  });

  it('reports an EMF chart as undecodable instead of finding nothing', () => {
    // The case that matters: a pasted Excel chart. No browser can decode EMF,
    // and the user is looking straight at the figure.
    const scan = imagesFromOoxml(pkg(imagePart('/word/media/image1.emf', 'image/x-emf', PNG_B64)));
    expect(scan.images).toEqual([]);
    expect(scan.undecodable).toEqual(['image/x-emf']);
  });

  it('still returns the decodable images when a metafile sits beside them', () => {
    const scan = imagesFromOoxml(
      pkg(
        imagePart('/word/media/image1.emf', 'image/x-wmf', PNG_B64) +
          imagePart('/word/media/image2.png', 'image/png', PNG_B64),
      ),
    );
    expect(scan.images).toHaveLength(1);
    expect(scan.undecodable).toEqual(['image/x-wmf']);
  });

  it('tolerates a content type with parameters and odd casing', () => {
    const scan = imagesFromOoxml(
      pkg(imagePart('/word/media/i.png', 'IMAGE/PNG; charset=binary', PNG_B64)),
    );
    expect(scan.images[0]?.mediaType).toBe('image/png');
  });

  it('finds nothing in a selection of plain text', () => {
    const scan = imagesFromOoxml(pkg(documentPart));
    expect(scan).toEqual({ images: [], undecodable: [] });
  });

  it('skips an image part with no binary payload', () => {
    const scan = imagesFromOoxml(
      pkg(`<pkg:part pkg:name="/word/media/i.png" pkg:contentType="image/png"/>`),
    );
    expect(scan.images).toEqual([]);
  });

  it('returns an empty scan rather than throwing on junk', () => {
    // A malformed package is something to explain, not an exception to bubble
    // up through a click handler.
    expect(imagesFromOoxml('not xml at all <<<')).toEqual({ images: [], undecodable: [] });
    expect(imagesFromOoxml('')).toEqual({ images: [], undecodable: [] });
    expect(imagesFromOoxml('<other:thing/>')).toEqual({ images: [], undecodable: [] });
  });

  it('does not expand entities', () => {
    // Same posture as pubmed.schemas.ts: a package with expanding entities
    // should cost nothing rather than exhaust memory.
    const bomb = `<?xml version="1.0"?>
<!DOCTYPE p [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>
${pkg(imagePart('/word/media/i.png', 'image/png', PNG_B64))}`;
    const scan = imagesFromOoxml(bomb);
    expect(scan.images[0]?.dataBase64).toBe(PNG_B64);
  });
});

describe('isMetafile', () => {
  it('recognises the formats Word uses for charts and equations', () => {
    expect(isMetafile('image/x-emf')).toBe(true);
    expect(isMetafile('IMAGE/X-WMF')).toBe(true);
    expect(isMetafile('image/png')).toBe(false);
  });
});

describe('describeUndecodable', () => {
  it('names the workaround that actually works for a metafile', () => {
    // Copying in Word puts a bitmap on the clipboard, which the paste path
    // handles — so the message has to point there, not just apologise.
    expect(describeUndecodable(['image/x-emf'])).toMatch(/paste it into the prompt box/i);
    expect(describeUndecodable(['image/x-emf'])).toMatch(/metafile/i);
  });

  it('names the format for anything else it cannot read', () => {
    expect(describeUndecodable(['image/tiff'])).toContain('image/tiff');
  });
});
