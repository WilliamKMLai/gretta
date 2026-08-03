import { describe, expect, it } from 'vitest';
import type { IndexProgressEvent } from '../../src/types/knowledgebase';
import { ProgressParseError, encodeProgress, parseProgressLine } from './progress.mts';

const samples: IndexProgressEvent[] = [
  { type: 'phase', phase: 'indexing' },
  { type: 'scan', totalFiles: 12 },
  { type: 'file', path: 'refs/a.pdf', filesDone: 3, totalFiles: 12 },
  { type: 'skip', path: 'refs/notes.key', reason: 'unsupported file type .key' },
  { type: 'error', path: null, message: 'Ollama embeddings unreachable' },
  { type: 'error', path: 'refs/b.docx', message: 'parse failed' },
  { type: 'done', chunkCount: 240, fileCount: 12 },
];

describe('progress NDJSON seam', () => {
  it('round-trips every event type through encode → parse', () => {
    for (const event of samples) {
      const line = encodeProgress(event);
      expect(line.endsWith('\n')).toBe(true);
      expect(parseProgressLine(line.trimEnd())).toEqual(event);
    }
  });

  it('throws ProgressParseError on invalid JSON', () => {
    expect(() => parseProgressLine('{not json')).toThrow(ProgressParseError);
  });

  it('throws on an unknown event type', () => {
    expect(() => parseProgressLine('{"type":"wat"}')).toThrow(ProgressParseError);
  });

  it('throws on an unknown phase', () => {
    expect(() => parseProgressLine('{"type":"phase","phase":"melting"}')).toThrow(
      ProgressParseError,
    );
  });

  it('throws when a required field has the wrong type', () => {
    expect(() => parseProgressLine('{"type":"scan","totalFiles":"lots"}')).toThrow(
      ProgressParseError,
    );
  });
});
