/**
 * History store tests (ADR-021): records are independent, bounded, and never
 * imply continuity between runs.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { GenerationRecord } from '../../types/domain';
import { HISTORY_LIMIT, describeRecord, useHistoryStore } from './history.store';

const run = (over: Partial<GenerationRecord> = {}) => ({
  prompt: 'tidy this',
  response: 'Tidied.',
  model: 'llama3',
  outcome: 'completed' as const,
  ...over,
});

beforeEach(() => {
  useHistoryStore.setState({ records: [], activeRecordId: null });
});

describe('useHistoryStore', () => {
  it('adds records newest-first and activates the new one', () => {
    const store = useHistoryStore.getState();
    const first = store.addRecord(run({ prompt: 'first' }));
    const second = useHistoryStore.getState().addRecord(run({ prompt: 'second' }));

    const { records, activeRecordId } = useHistoryStore.getState();
    expect(records.map((record) => record.prompt)).toEqual(['second', 'first']);
    expect(activeRecordId).toBe(second);
    expect(first).not.toBe(second);
  });

  it('stamps an id and timestamp on each record', () => {
    useHistoryStore.getState().addRecord(run());
    const [record] = useHistoryStore.getState().records;
    expect(record?.id).toBeTruthy();
    expect(Number.isNaN(Date.parse(record?.createdAt ?? ''))).toBe(false);
  });

  it('keeps cancelled and failed runs, with their partial text', () => {
    useHistoryStore.getState().addRecord(run({ response: 'partial', outcome: 'cancelled' }));
    expect(useHistoryStore.getState().records[0]).toMatchObject({
      response: 'partial',
      outcome: 'cancelled',
    });
  });

  it('deletes a record and clears the active id when it was active', () => {
    const id = useHistoryStore.getState().addRecord(run());
    useHistoryStore.getState().deleteRecord(id);
    expect(useHistoryStore.getState().records).toHaveLength(0);
    expect(useHistoryStore.getState().activeRecordId).toBeNull();
  });

  it('leaves the active id alone when a different record is deleted', () => {
    const older = useHistoryStore.getState().addRecord(run({ prompt: 'older' }));
    const newer = useHistoryStore.getState().addRecord(run({ prompt: 'newer' }));
    useHistoryStore.getState().deleteRecord(older);
    expect(useHistoryStore.getState().activeRecordId).toBe(newer);
  });

  it('clears everything', () => {
    useHistoryStore.getState().addRecord(run());
    useHistoryStore.getState().clearRecords();
    expect(useHistoryStore.getState().records).toEqual([]);
    expect(useHistoryStore.getState().activeRecordId).toBeNull();
  });

  it('records that a result was applied to the document', () => {
    const id = useHistoryStore.getState().addRecord(run());
    useHistoryStore.getState().markApplied(id, 'insert');
    expect(useHistoryStore.getState().records[0]?.applied?.kind).toBe('insert');
  });

  it('ignores markApplied for an unknown id', () => {
    useHistoryStore.getState().addRecord(run());
    useHistoryStore.getState().markApplied('nope', 'insert');
    expect(useHistoryStore.getState().records[0]?.applied).toBeUndefined();
  });

  it('caps history so storage cannot grow without bound', () => {
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
      useHistoryStore.getState().addRecord(run({ prompt: `run ${String(i)}` }));
    }
    const { records } = useHistoryStore.getState();
    expect(records).toHaveLength(HISTORY_LIMIT);
    expect(records[0]?.prompt).toBe(`run ${String(HISTORY_LIMIT + 4)}`);
  });

  it('carries retrieved sources onto the record', () => {
    useHistoryStore.getState().addRecord(
      run({
        sources: [
          {
            collectionId: 'refs',
            source: 'paper.pdf',
            locator: { page: 2, paragraph: null },
            text: 'excerpt',
            score: 0.9,
          },
        ],
      }),
    );
    expect(useHistoryStore.getState().records[0]?.sources).toHaveLength(1);
  });
});

describe('describeRecord', () => {
  const base: GenerationRecord = {
    id: 'r',
    createdAt: '2026-01-01T00:00:00.000Z',
    prompt: '',
    response: '',
    model: 'llama3',
    outcome: 'completed',
  };

  it('uses the prompt, collapsing whitespace', () => {
    expect(describeRecord({ ...base, prompt: '  make   it\n pop ' })).toBe('make it pop');
  });

  it('falls back to the template name for a promptless run', () => {
    expect(describeRecord({ ...base, templateName: 'Tidy up' })).toBe('Tidy up');
  });

  it('falls back again when there is nothing at all', () => {
    expect(describeRecord(base)).toBe('Untitled generation');
  });
});
