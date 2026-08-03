/**
 * Word requirement-set facts (resolves ARCHITECTURE.md §17 item 3, Phase 3).
 *
 * Verified against the official reference annotations embedded in
 * `@types/office-js` (`[Api set: …]` remarks), 2026-07-14:
 *
 * | Member                                                        | Set |
 * | ------------------------------------------------------------- | --- |
 * | Document.getSelection · Range.text/insertText/select          | 1.1 |
 * | Range.paragraphs · Body.text/insertText · Font.highlightColor | 1.1 |
 * | Range.insertComment                                           | 1.4 |
 *
 * Why the manifest still requires **1.3** even though every core member is
 * 1.1: under sets 1.1/1.2, `paragraphs` collections **exclude paragraphs
 * inside tables** (per the same reference). `getParagraph` silently returning
 * nothing when the cursor sits in a table is exactly the kind of ghost bug we
 * refuse to ship, so 1.3 is the correctness floor, not a preference.
 * Comments stay a runtime gate — 1.4 must never become an install-time wall.
 */

/** Manifest floor (manifest/manifest.xml <Requirements>). */
export const WORD_API_BASELINE = '1.3';

/** Runtime-gated set for `createComment` (Range.insertComment). */
export const WORD_API_COMMENTS = '1.4';

/**
 * Compares dotted requirement-set versions numerically ("1.10" > "1.4" —
 * string comparison would get that wrong). Missing segments count as 0.
 */
export function isVersionAtLeast(actual: string, minimum: string): boolean {
  const a = actual.split('.').map((part) => Number(part) || 0);
  const b = minimum.split('.').map((part) => Number(part) || 0);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}
