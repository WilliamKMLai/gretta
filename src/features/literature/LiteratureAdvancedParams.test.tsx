/**
 * SpinButton typing test: the field this guards against is a clamped `Input`
 * that snapped back to its minimum after the first keystroke, making a value
 * below the previous one — e.g. typing "20" over "50" — untypeable one digit
 * at a time.
 */
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { useSettingsStore } from '../settings';
import { LiteratureAdvancedParams } from './LiteratureAdvancedParams';

const initialSettings = useSettingsStore.getState();

function wrap(children: ReactNode): ReactElement {
  return <FluentProvider theme={webLightTheme}>{children}</FluentProvider>;
}

beforeEach(() => {
  useSettingsStore.setState(initialSettings, true);
});

describe('LiteratureAdvancedParams', () => {
  it('lets a lower two-digit value be typed over the current one, digit by digit', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ litResultsPerSource: 50 });

    render(wrap(<LiteratureAdvancedParams />));
    await user.click(screen.getByRole('button', { name: /advanced search parameters/i }));

    const input = screen.getByRole('spinbutton', { name: /results per source/i });
    await user.clear(input);
    await user.type(input, '20');
    await user.tab();

    expect(useSettingsStore.getState().litResultsPerSource).toBe(20);
  });

  it('exposes the citation-impact weight as a tunable field, defaulting to 0.6', async () => {
    const user = userEvent.setup();

    render(wrap(<LiteratureAdvancedParams />));
    await user.click(screen.getByRole('button', { name: /advanced search parameters/i }));

    const input = screen.getByRole('spinbutton', { name: /citation impact weight/i });
    expect(input).toHaveValue('0.6');

    await user.clear(input);
    await user.type(input, '0.5');
    await user.tab();

    expect(useSettingsStore.getState().litCitationImpactWeight).toBe(0.5);
  });
});
