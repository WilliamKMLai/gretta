import { OfficeError } from '../../types/errors';
import { MockOfficeService } from './office.mock';

const DOC = 'First paragraph here.\nSecond one follows.\nThird closes the file.';

function makeMock(overrides: ConstructorParameters<typeof MockOfficeService>[0] = {}) {
  return new MockOfficeService({ initialText: DOC, ...overrides });
}

describe('MockOfficeService', () => {
  it('reports an empty selection for a collapsed cursor', async () => {
    const mock = makeMock();
    await expect(mock.getSelection()).resolves.toEqual({ text: '', isEmpty: true });
  });

  it('reads the selected text', async () => {
    const mock = makeMock();
    mock.selectText('Second one');
    await expect(mock.getSelection()).resolves.toEqual({ text: 'Second one', isEmpty: false });
  });

  it('returns the paragraph containing a collapsed cursor', async () => {
    const mock = makeMock();
    mock.selectText('follows');
    const { selection } = mock.getState();
    mock.setSelection(selection.start, selection.start); // collapse
    await expect(mock.getParagraph()).resolves.toBe('Second one follows.');
  });

  it('joins every paragraph a multi-paragraph selection touches', async () => {
    const mock = makeMock();
    const start = DOC.indexOf('here');
    const end = DOC.indexOf('follows');
    mock.setSelection(start, end);
    await expect(mock.getParagraph()).resolves.toBe('First paragraph here.\nSecond one follows.');
  });

  it('replaceSelection swaps the text and parks the cursor after it', async () => {
    const mock = makeMock();
    mock.selectText('Second one follows.');
    await mock.replaceSelection('Replaced!');
    const state = mock.getState();
    expect(state.text).toBe('First paragraph here.\nReplaced!\nThird closes the file.');
    expect(state.selection).toEqual({
      start: DOC.indexOf('Second') + 'Replaced!'.length,
      end: DOC.indexOf('Second') + 'Replaced!'.length,
      text: '',
    });
  });

  it('insertAtCursor inserts after the selection without removing it', async () => {
    const mock = makeMock();
    mock.selectText('First paragraph');
    await mock.insertAtCursor(' [note]');
    expect(mock.getState().text).toContain('First paragraph [note] here.');
  });

  it('appendText adds a separating newline, mirroring the real service', async () => {
    const mock = makeMock();
    await mock.appendText('Appended line.');
    expect(mock.getState().text).toBe(`${DOC}\nAppended line.`);
  });

  it('records comments with their selection anchor when 1.4 is supported', async () => {
    const mock = makeMock();
    mock.selectText('Third');
    await mock.createComment('Check this word');
    expect(mock.getState().comments).toEqual([{ text: 'Check this word', anchor: 'Third' }]);
  });

  it('rejects createComment with api-unsupported below WordApi 1.4', async () => {
    const mock = makeMock({ supportedSets: { WordApi: '1.3' } });
    const failure = await mock.createComment('nope').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(OfficeError);
    expect((failure as OfficeError).kind).toBe('api-unsupported');
  });

  it('records highlights and clear-highlight calls', async () => {
    const mock = makeMock();
    mock.selectText('closes');
    await mock.highlightSelection('green');
    await mock.highlightSelection('none');
    expect(mock.getState().highlights).toEqual([
      { color: 'green', anchor: 'closes' },
      { color: null, anchor: 'closes' },
    ]);
  });

  it('compares requirement-set versions numerically, not lexically', () => {
    const mock = makeMock({ supportedSets: { WordApi: '1.10' } });
    expect(mock.isApiSupported('WordApi', '1.4')).toBe(true);
    expect(mock.isApiSupported('WordApi', '1.11')).toBe(false);
  });

  it('failNextOperation makes exactly one operation reject', async () => {
    const mock = makeMock();
    mock.failNextOperation();
    await expect(mock.getDocument()).rejects.toBeInstanceOf(OfficeError);
    await expect(mock.getDocument()).resolves.toBe(DOC);
  });
});
