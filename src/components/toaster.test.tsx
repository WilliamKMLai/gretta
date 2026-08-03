import { fireEvent, render, screen } from '@testing-library/react';
import { Toaster } from '@fluentui/react-components';
import type { ReactElement } from 'react';
import { APP_TOASTER_ID, useAppToasts } from './toaster';

function Probe({ onAction }: { onAction: () => void }): ReactElement {
  const toasts = useAppToasts();
  return (
    <button
      type="button"
      onClick={() => {
        toasts.error('Clipboard blocked here.', { label: 'Copy result', onClick: onAction });
      }}
    >
      fire
    </button>
  );
}

describe('useAppToasts action slot', () => {
  it('renders the action link and clicking it runs the callback (a real user gesture)', async () => {
    const onAction = vi.fn();
    render(
      <>
        <Toaster toasterId={APP_TOASTER_ID} />
        <Probe onAction={onAction} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'fire' }));
    expect(await screen.findByText('Clipboard blocked here.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Copy result'));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
