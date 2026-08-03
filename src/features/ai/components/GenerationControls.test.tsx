import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStreamStore } from '../stream.store';
import { GenerationControls } from './GenerationControls';

const initial = useStreamStore.getState();
beforeEach(() => {
  useStreamStore.setState(initial, true);
});

const renderControls = (reason?: string): void => {
  render(
    <FluentProvider theme={webLightTheme}>
      <GenerationControls
        onGenerate={() => undefined}
        {...(reason === undefined ? {} : { generateDisabledReason: reason })}
      />
    </FluentProvider>,
  );
};

describe('GenerationControls', () => {
  it('idle: Generate enabled, Stop and Clear disabled', () => {
    renderControls();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
  });

  it('active: Stop enabled and cancels the machine', async () => {
    const user = userEvent.setup();
    useStreamStore.getState().start({ model: 'llama3.1:8b', promptId: null });
    useStreamStore.getState().appendToken('partial');
    renderControls();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(useStreamStore.getState().status).toBe('cancelled');
  });

  it('vetoes Generate when a disabled reason is supplied', () => {
    renderControls('Pick a model first');
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
  });
});
