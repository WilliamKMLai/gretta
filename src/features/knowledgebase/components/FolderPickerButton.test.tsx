/**
 * Folder-picker button tests (ADR-033).
 *
 * The dialog is a native modal awaiting a human, so what is testable here is
 * the decision surface around it: whether the button is offered at all, and
 * that a cancel is silent rather than an error.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { setServices } from '../../../app/services';
import type { KnowledgeBaseClient } from '../../../services/knowledgebase';
import type { KnowledgeBaseHealth, PickFolderResult } from '../../../types/knowledgebase';
import { FolderPickerButton } from './FolderPickerButton';

function wrap(children: ReactNode): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <FluentProvider theme={webLightTheme}>{children}</FluentProvider>
    </QueryClientProvider>
  );
}

function stubKb(health: Partial<KnowledgeBaseHealth>, pick: () => Promise<PickFolderResult>): void {
  setServices({
    kb: {
      health: () => Promise.resolve({ name: 'gretta-kb', version: '1.0.0', ok: true, ...health }),
      pickFolder: pick,
    } as unknown as KnowledgeBaseClient,
  });
}

const never = (): Promise<PickFolderResult> => Promise.reject(new Error('should not be called'));

describe('FolderPickerButton', () => {
  it('offers the button when the companion says it has a dialog', async () => {
    stubKb({ pickFolder: true }, never);
    render(wrap(<FolderPickerButton onPicked={vi.fn()} />));
    expect(await screen.findByRole('button', { name: /choose folder/i })).toBeVisible();
  });

  it.each([
    ['the platform has no dialog', { pickFolder: false }],
    ['the companion is too old to say', {}],
  ])('renders nothing when %s', async (_case, health) => {
    // Hidden, not disabled: a visible control that cannot open anything is
    // worse than none, and the text input beside it is a complete way in.
    stubKb(health, never);
    render(wrap(<FolderPickerButton onPicked={vi.fn()} />));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /choose folder/i })).toBeNull();
    });
  });

  it('reports the chosen path', async () => {
    const onPicked = vi.fn();
    stubKb({ pickFolder: true }, () =>
      Promise.resolve({ ok: true, path: '/Users/you/Documents/References' }),
    );

    render(wrap(<FolderPickerButton onPicked={onPicked} />));
    await userEvent.click(await screen.findByRole('button', { name: /choose folder/i }));

    await waitFor(() => {
      expect(onPicked).toHaveBeenCalledWith('/Users/you/Documents/References');
    });
  });

  it.each(['cancelled', 'busy'] as const)(
    'says nothing and changes nothing on %s',
    async (reason) => {
      // Dismissing a dialog is a normal thing to do. Rendering it as a failure
      // is the same mistake as treating a cancelled search as an error.
      const onPicked = vi.fn();
      stubKb({ pickFolder: true }, () => Promise.resolve({ ok: false, reason }));

      render(wrap(<FolderPickerButton onPicked={onPicked} />));
      const button = await screen.findByRole('button', { name: /choose folder/i });
      await userEvent.click(button);

      await waitFor(() => {
        expect(button).toBeEnabled();
      });
      expect(onPicked).not.toHaveBeenCalled();
      expect(screen.queryByRole('tooltip')).toBeNull();
    },
  );

  it('surfaces a real failure without calling back with a path', async () => {
    const onPicked = vi.fn();
    stubKb({ pickFolder: true }, () =>
      Promise.resolve({ ok: false, reason: 'failed', message: 'Not authorised' }),
    );

    render(wrap(<FolderPickerButton onPicked={onPicked} />));
    await userEvent.click(await screen.findByRole('button', { name: /choose folder/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /choose folder/i })).toBeEnabled();
    });
    expect(onPicked).not.toHaveBeenCalled();
  });

  it('survives the companion disappearing between the health check and the click', async () => {
    const onPicked = vi.fn();
    stubKb({ pickFolder: true }, () => Promise.reject(new Error('offline')));

    render(wrap(<FolderPickerButton onPicked={onPicked} />));
    await userEvent.click(await screen.findByRole('button', { name: /choose folder/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /choose folder/i })).toBeEnabled();
    });
    expect(onPicked).not.toHaveBeenCalled();
  });
});
