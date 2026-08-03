import { downloadTextFile } from './download';

describe('downloadTextFile', () => {
  it('creates, clicks, and cleans up a blob anchor', () => {
    // jsdom has no object-URL support — stub the pair the util relies on.
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    downloadTextFile('note.md', '# hi\n', 'text/markdown');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    expect(document.querySelector('a')).toBeNull();
    click.mockRestore();
  });
});
