/**
 * Generation record → Markdown / JSON (ADR-021).
 *
 * Pure functions; the download itself goes through utils/download. Exports
 * include the retrieved sources, because a result without its provenance is
 * exactly what makes RAG output hard to trust later.
 */
import type { GenerationRecord } from '../../types/domain';

function citation(chunk: NonNullable<GenerationRecord['sources']>[number]): string {
  if (chunk.locator.page !== null) return `${chunk.source}, p. ${String(chunk.locator.page)}`;
  if (chunk.locator.paragraph !== null) {
    return `${chunk.source}, ¶${String(chunk.locator.paragraph)}`;
  }
  return chunk.source;
}

export function recordToMarkdown(record: GenerationRecord): string {
  const heading = record.templateName ?? 'Generation';
  const lines: string[] = [
    `# ${heading}`,
    '',
    `_${record.createdAt} · ${record.model}${
      record.outcome === 'completed' ? '' : ` · ${record.outcome}`
    }_`,
    '',
    '## Prompt',
    '',
    record.prompt === '' ? '_(no prompt text)_' : record.prompt,
    '',
    '## Response',
    '',
    record.response === '' ? '_(no response)_' : record.response,
    '',
  ];

  if (record.sources !== undefined && record.sources.length > 0) {
    lines.push('## Sources', '');
    record.sources.forEach((chunk, index) => {
      lines.push(`${String(index + 1)}. ${citation(chunk)}`);
    });
    lines.push('');
  }
  if (record.stats !== undefined) {
    lines.push(
      `_${String(record.stats.evalCount)} tokens · ${String(record.stats.tokensPerSecond)} tok/s_`,
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function recordToJson(record: GenerationRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** All of history as one JSON document, newest first. */
export function historyToJson(records: readonly GenerationRecord[]): string {
  return `${JSON.stringify({ records }, null, 2)}\n`;
}

/** `tidy-this-paragraph-2026-07-15.md` — safe, sortable, collision-resistant enough. */
export function exportFilename(record: GenerationRecord, extension: 'md' | 'json'): string {
  const basis = record.prompt.trim() !== '' ? record.prompt : (record.templateName ?? 'generation');
  const slug =
    basis
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 40) || 'generation';
  return `${slug}-${record.createdAt.slice(0, 10)}.${extension}`;
}
