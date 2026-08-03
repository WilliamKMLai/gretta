/**
 * NDJSON progress seam for the knowledge-base companion (DECISIONS.md
 * ADR-020). `GET /status/stream` emits one JSON object per line while the
 * index runs — the same line-oriented transport as Ollama's `/api/chat`, so
 * the webview reuses the incremental-parse discipline. This module owns the
 * encode side (companion) and a defensive parse side (both), and is
 * unit-tested exactly like `services/ollama/ndjson.ts`. Pure: validation is
 * hand-rolled so the companion needs no Zod dependency; the webview validates
 * the richer HTTP bodies with Zod in `services/knowledgebase/schemas.ts`.
 */
import type { IndexPhase, IndexProgressEvent } from '../../src/types/knowledgebase';

const PHASES: readonly IndexPhase[] = [
  'disabled',
  'idle',
  'scanning',
  'indexing',
  'ready',
  'ollama-unreachable',
  'error',
];

/** Serializes one progress event to a single newline-terminated NDJSON line. */
export function encodeProgress(event: IndexProgressEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** Raised on a structurally invalid progress line (never a raw TypeError). */
export class ProgressParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgressParseError';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new ProgressParseError('progress line is not a JSON object');
  }
  return value as Record<string, unknown>;
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new ProgressParseError(`"${key}" must be a string`);
  return value;
}

function num(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProgressParseError(`"${key}" must be a finite number`);
  }
  return value;
}

/**
 * Parses one NDJSON line into a typed event. Throws `ProgressParseError` on
 * any shape mismatch — the stream reader maps that to a friendly "lost the
 * indexer's progress feed" state without crashing.
 */
export function parseProgressLine(line: string): IndexProgressEvent {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (cause) {
    throw new ProgressParseError(
      `progress line is not valid JSON: ${cause instanceof Error ? cause.message : 'unknown'}`,
    );
  }
  const record = asRecord(json);
  const type = record.type;
  switch (type) {
    case 'phase': {
      const phase = str(record, 'phase');
      if (!(PHASES as readonly string[]).includes(phase)) {
        throw new ProgressParseError(`unknown phase "${phase}"`);
      }
      return { type: 'phase', phase: phase as IndexPhase };
    }
    case 'scan':
      return { type: 'scan', totalFiles: num(record, 'totalFiles') };
    case 'file':
      return {
        type: 'file',
        path: str(record, 'path'),
        filesDone: num(record, 'filesDone'),
        totalFiles: num(record, 'totalFiles'),
      };
    case 'skip':
      return { type: 'skip', path: str(record, 'path'), reason: str(record, 'reason') };
    case 'error':
      return {
        type: 'error',
        path: record.path === null ? null : str(record, 'path'),
        message: str(record, 'message'),
      };
    case 'done':
      return {
        type: 'done',
        chunkCount: num(record, 'chunkCount'),
        fileCount: num(record, 'fileCount'),
      };
    default:
      throw new ProgressParseError(`unknown event type ${JSON.stringify(type)}`);
  }
}
