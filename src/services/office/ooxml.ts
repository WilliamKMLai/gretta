/**
 * Pulling image parts out of a Word OOXML package (DECISIONS.md ADR-035).
 *
 * `getSelectedDataAsync(Ooxml)` returns a flat package: `<pkg:part>` entries,
 * each with a content type, and for binary parts a `<pkg:binaryData>` payload
 * of base64. This finds the image parts. It is pure — no Office.js, no DOM — so
 * it is unit-tested against real package fixtures while the Office call around
 * it is verified by hand in Word.
 *
 * The metafile case is the reason this file has more logic than "filter by
 * content type". Word stores a pasted Excel chart, an equation, or a drawing
 * canvas as EMF or WMF, and no browser can decode either — `createImageBitmap`
 * fails outright. Those parts are recognised and reported rather than silently
 * skipped, because "no image found" is a lie to someone looking straight at
 * their figure.
 *
 * Entity expansion is off, matching `services/literature/pubmed.schemas.ts`.
 * This XML comes from Word rather than a third party so the risk is lower, but
 * one parser configured two ways in one codebase is a trap for the next reader.
 */
import { XMLParser } from 'fast-xml-parser';

/** Raster content types a browser can actually decode into pixels. */
const DECODABLE = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/bmp',
  'image/webp',
]);

/** Vector/metafile types Word emits that no browser can decode (ADR-035). */
const METAFILE = new Set(['image/x-emf', 'image/x-wmf', 'image/emf', 'image/wmf']);

/** One decodable image recovered from a package. */
export interface OoxmlImage {
  /** Part name, e.g. `/word/media/image1.png` — used as the display name. */
  name: string;
  mediaType: string;
  /** Base64 payload with all whitespace removed. */
  dataBase64: string;
}

export interface OoxmlImageScan {
  images: OoxmlImage[];
  /**
   * Content types found that a browser cannot decode. Non-empty with an empty
   * `images` is the "your chart is a metafile" case the UI must explain.
   */
  undecodable: string[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // Base64 must survive verbatim; letting the parser coerce it to a number
  // would quietly destroy an all-digit payload.
  parseTagValue: false,
  trimValues: true,
  processEntities: false,
});

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Word wraps base64 at column boundaries; the decoder wants it unbroken. */
function compact(value: string): string {
  return value.replace(/\s+/gu, '');
}

/**
 * Finds every image part in an OOXML package.
 *
 * Never throws: a package that will not parse yields an empty scan, matching
 * how the knowledge-base parsers report an unreadable file rather than raising.
 * A malformed package is a thing to explain, not an exception to bubble up
 * through a click handler.
 */
export function imagesFromOoxml(xml: string): OoxmlImageScan {
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return { images: [], undecodable: [] };
  }
  if (!isRecord(parsed)) return { images: [], undecodable: [] };

  const pkg = parsed['pkg:package'] ?? parsed.package;
  if (!isRecord(pkg)) return { images: [], undecodable: [] };

  const images: OoxmlImage[] = [];
  const undecodable: string[] = [];

  for (const part of asArray(pkg['pkg:part'] ?? pkg.part)) {
    if (!isRecord(part)) continue;
    const contentType = part['@pkg:contentType'] ?? part['@contentType'];
    if (typeof contentType !== 'string') continue;
    const mediaType = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
    if (!mediaType.startsWith('image/')) continue;

    // Reported whether or not it is a known metafile: the user can see a
    // picture, so anything we cannot turn into pixels needs explaining.
    if (!DECODABLE.has(mediaType)) {
      undecodable.push(mediaType);
      continue;
    }

    const binary = part['pkg:binaryData'] ?? part.binaryData;
    if (typeof binary !== 'string') continue;
    const dataBase64 = compact(binary);
    if (dataBase64 === '') continue;

    const partName = part['@pkg:name'] ?? part['@name'];
    images.push({
      name: typeof partName === 'string' ? partName : 'figure',
      mediaType,
      dataBase64,
    });
  }

  return { images, undecodable };
}

/** True when a content type is one Word uses and browsers cannot decode. */
export function isMetafile(mediaType: string): boolean {
  return METAFILE.has(mediaType.toLowerCase());
}

/**
 * The message for a selection that held only undecodable pictures.
 *
 * Names the format and gives the workaround that actually works: copying the
 * figure in Word puts a bitmap on the clipboard, which the paste path handles.
 */
export function describeUndecodable(types: readonly string[]): string {
  const metafile = types.some(isMetafile);
  return metafile
    ? 'That figure is a Windows metafile (an Excel chart, equation, or drawing), which cannot be read directly. Copy it in Word and paste it into the prompt box instead.'
    : `That figure is in a format GRETTA can't read (${types.join(', ')}). Copy it in Word and paste it into the prompt box instead.`;
}
