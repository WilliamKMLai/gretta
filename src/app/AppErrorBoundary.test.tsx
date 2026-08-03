import { render, screen } from '@testing-library/react';
import { AppErrorBoundary } from './AppErrorBoundary';

function Bomb(): never {
  throw new Error('kaboom in render');
}

describe('AppErrorBoundary', () => {
  it('renders children when healthy', () => {
    render(
      <AppErrorBoundary>
        <div>healthy child</div>
      </AppErrorBoundary>,
    );
    expect(screen.getByText('healthy child')).toBeInTheDocument();
  });

  it('catches render-time throws and shows the copyable report', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('kaboom in render');
    expect(screen.getByRole('button', { name: 'Reload pane' })).toBeInTheDocument();
    spy.mockRestore();
  });
});
