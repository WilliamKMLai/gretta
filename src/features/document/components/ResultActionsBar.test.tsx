import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getServices, initServices, setServices } from '../../../app/services';
import type { HostInfo } from '../../../services/office';
import { ResultActionsBar } from './ResultActionsBar';

const BROWSER_HOST: HostInfo = { available: false, host: 'unknown', platform: 'unknown' };

afterEach(() => {
  initServices(BROWSER_HOST);
});

const renderBar = (text: string): void => {
  render(
    <FluentProvider theme={webLightTheme}>
      <ResultActionsBar text={text} record={null} onRefine={() => undefined} refineDisabled />
    </FluentProvider>,
  );
};

describe('ResultActionsBar', () => {
  it('disables every action without a result', () => {
    renderBar('');
    for (const name of ['Copy', 'Replace', 'Insert', 'Export']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });

  it('copies the result through the clipboard service', async () => {
    const user = userEvent.setup();
    const copy = vi.fn(() => Promise.resolve());
    setServices({ clipboard: { copy } });
    renderBar('the result');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(copy).toHaveBeenCalledWith('the result');
  });

  it('hides Comment when WordApi 1.4 is unsupported', () => {
    vi.spyOn(getServices().office, 'isApiSupported').mockReturnValue(false);
    renderBar('text');
    expect(screen.queryByRole('button', { name: 'Comment' })).not.toBeInTheDocument();
  });

  it('exports bare results as Markdown', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    renderBar('export me');
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Markdown (.md)' }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });
});

describe('compact pane (ADR-027)', () => {
  it('keeps Copy and Insert inline and moves the rest behind More', () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <ResultActionsBar
          text="result"
          record={null}
          onRefine={() => undefined}
          refineDisabled={false}
          compact
        />
      </FluentProvider>,
    );
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Insert' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
    // Replace/Refine/Export are still reachable, just not competing for space.
    expect(screen.queryByRole('button', { name: 'Replace' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
  });

  it('shows every action inline when there is room', () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <ResultActionsBar
          text="result"
          record={null}
          onRefine={() => undefined}
          refineDisabled={false}
        />
      </FluentProvider>,
    );
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
  });
});
