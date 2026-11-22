/**
 * A small Markdown reader for model output (DECISIONS.md ADR-026).
 *
 * Deliberately not a Markdown library. Two reasons:
 *
 *  - **Safety by construction.** This produces a data structure, never an HTML
 *    string, so the renderer builds React elements and there is no
 *    `dangerouslySetInnerHTML` anywhere in the path. Model output is data
 *    (§13.1) and nothing here can turn it into markup.
 *  - **Scope.** Models emit a narrow, predictable subset — headings, emphasis,
 *    code, lists, quotes. Supporting that well is a few hundred tested lines;
 *    supporting all of CommonMark is a dependency and a much larger attack
 *    surface for no practical gain.
 *
 * Anything unrecognised degrades to plain text rather than being dropped.
 */

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'strong'; value: string }
  | { type: 'em'; value: string }
  | { type: 'code'; value: string }
  /** Links render as text plus a visible URL; never as a clickable anchor. */
  | { type: 'link'; value: string; href: string };

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3; inline: InlineNode[] }
  | { type: 'paragraph'; inline: InlineNode[] }
  | { type: 'code'; language: string | null; value: string }
  | { type: 'list'; ordered: boolean; items: InlineNode[][] }
  | { type: 'quote'; inline: InlineNode[] }
  | { type: 'rule' };

const WORD_CHAR = /[\p{L}\p{N}]/u;

function hasAdjacentWordChar(text: string, start: number, end: number): boolean {
  if (start > 0) {
    const before = Array.from(text.slice(Math.max(0, start - 2), start)).at(-1);
    if (before !== undefined && WORD_CHAR.test(before)) return true;
  }
  if (end < text.length) {
    const after = Array.from(text.slice(end, end + 2))[0];
    if (after !== undefined && WORD_CHAR.test(after)) return true;
  }
  return false;
}

/** Splits one line of text into styled spans. Unmatched text passes through. */
export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  const pattern =
    /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]+\]\((?:\([^()\s]*\)|[^()\s])+\))/gu;
  let textStart = 0;

  for (;;) {
    const match = pattern.exec(text);
    if (match === null) {
      if (textStart < text.length) {
        nodes.push({ type: 'text', value: text.slice(textStart) });
      }
      break;
    }

    const token = match[0];
    const start = match.index;
    const end = start + token.length;

    // Intraword underscores (`alpha_1 and alpha_2`, `top_p`, `foo__bar__baz`)
    // are identifiers or subscripts in technical prose, not emphasis.
    if (token.startsWith('_') && hasAdjacentWordChar(text, start, end)) {
      let next = start + 1;
      while (next < text.length && text[next] === '_') next += 1;
      pattern.lastIndex = next;
      continue;
    }

    if (start > textStart) {
      nodes.push({ type: 'text', value: text.slice(textStart, start) });
    }

    if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push({ type: 'strong', value: token.slice(2, -2) });
    } else if (token.startsWith('`')) {
      nodes.push({ type: 'code', value: token.slice(1, -1) });
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](');
      nodes.push({
        type: 'link',
        value: token.slice(1, split),
        href: token.slice(split + 2, -1),
      });
    } else {
      nodes.push({ type: 'em', value: token.slice(1, -1) });
    }

    textStart = end;
    pattern.lastIndex = end;
  }

  return nodes.filter((node) => node.type !== 'text' || node.value !== '');
}

/** Accepts h1–h6 as Markdown allows; deeper levels clamp to 3 when rendered. */
const HEADING = /^(#{1,6})\s+(.*)$/u;
const BULLET = /^\s*[-*+]\s+(.*)$/u;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/u;
const QUOTE = /^>\s?(.*)$/u;
const RULE = /^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/u;

/** Parses model output into blocks. Never throws; unknown syntax stays text. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join(' ').trim()) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    // Fenced code runs to its closing fence, or to the end if never closed —
    // a stream cut mid-block must still render as code, not as stray markup.
    if (line.trimStart().startsWith('```')) {
      flushParagraph();
      const language = line.trimStart().slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      blocks.push({
        type: 'code',
        language: language === '' ? null : language,
        value: body.join('\n'),
      });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ type: 'rule' });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushParagraph();
      const level = Math.min(3, (heading[1] ?? '#').length) as 1 | 2 | 3;
      blocks.push({ type: 'heading', level, inline: parseInline(heading[2] ?? '') });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet === null ? NUMBERED.exec(line) : null;
    if (bullet !== null || numbered !== null) {
      flushParagraph();
      const ordered = numbered !== null;
      const items: InlineNode[][] = [parseInline(bullet?.[1] ?? numbered?.[1] ?? '')];
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? '';
        const nextMatch = ordered ? NUMBERED.exec(next) : BULLET.exec(next);
        if (nextMatch === null) break;
        items.push(parseInline(nextMatch[1] ?? ''));
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote !== null) {
      flushParagraph();
      blocks.push({ type: 'quote', inline: parseInline(quote[1] ?? '') });
      continue;
    }

    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

function inlineToText(nodes: InlineNode[]): string {
  return nodes
    .map((node) => (node.type === 'link' ? `${node.value} (${node.href})` : node.value))
    .join('');
}

/**
 * Markdown → clean prose for inserting into a document.
 *
 * Word receives plain text (§13.1), so without this a user gets literal
 * `**bold**` and `## Heading` in their manuscript. Structure is preserved
 * through spacing and list markers rather than syntax.
 */
export function markdownToPlainText(source: string): string {
  const out: string[] = [];
  for (const block of parseMarkdown(source)) {
    switch (block.type) {
      case 'heading':
        out.push(inlineToText(block.inline));
        break;
      case 'paragraph':
        out.push(inlineToText(block.inline));
        break;
      case 'code':
        out.push(block.value);
        break;
      case 'quote':
        out.push(inlineToText(block.inline));
        break;
      case 'list':
        out.push(
          block.items
            .map((item, index) =>
              block.ordered
                ? `${String(index + 1)}. ${inlineToText(item)}`
                : `• ${inlineToText(item)}`,
            )
            .join('\n'),
        );
        break;
      case 'rule':
        break;
    }
  }
  return out.join('\n\n').trim();
}
