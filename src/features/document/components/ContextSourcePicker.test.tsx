import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextSourcePicker } from './ContextSourcePicker';

describe('ContextSourcePicker', () => {
  it('shows the current source on the chip', () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <ContextSourcePicker value="selection" options={['none', 'selection']} onChange={vi.fn()} />
      </FluentProvider>,
    );
    expect(screen.getByRole('button', { name: 'Context: Selection' })).toBeInTheDocument();
  });

  it('offers only the allowed options and reports changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FluentProvider theme={webLightTheme}>
        <ContextSourcePicker
          value="selection"
          options={['selection', 'document']}
          onChange={onChange}
        />
      </FluentProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Context: Selection' }));
    expect(screen.queryByRole('menuitemradio', { name: 'None' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitemradio', { name: 'Whole document' }));
    expect(onChange).toHaveBeenCalledWith('document');
  });
});
