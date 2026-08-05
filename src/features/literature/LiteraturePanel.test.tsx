/**
 * Literature panel tests.
 *
 * The case that matters here is the busy state. It broke in a way neither the
 * store tests nor the service tests could see: `setError(null)` also reset
 * `phase`, so the standard opening sequence set the busy state and erased it on
 * the next line. Everything still *worked* — the search ran and results
 * appeared — but for several seconds the pane looked identical to a dead
 * button, which is indistinguishable from broken to the person using it.
 *
 * So these assert what the user can see while waiting, not just what the store
 * holds.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { setServices } from '../../app/services';
import type { OfficeService, SelectionInfo } from '../../services/office';
import type { OllamaClient, StreamEvent } from '../../services/ollama';
import { useSettingsStore } from '../settings';
import { useLiteratureStore } from './literature.store';
import { LiteraturePanel } from './LiteraturePanel';

const initialSettings = useSettingsStore.getState();
const initialLiterature = useLiteratureStore.getState();

/** Resolves only when the test says so, so the pending state can be inspected. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function wrap(children: ReactNode): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <FluentProvider theme={webLightTheme}>{children}</FluentProvider>
    </QueryClientProvider>
  );
}

function stubOffice(selection: Promise<SelectionInfo>): Partial<OfficeService> {
  return { getSelection: () => selection };
}

/** A generation that produces nothing; drafting then leaves an empty field. */
function noTokens(): AsyncIterable<StreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      // Intentionally yields nothing.
    },
  };
}

beforeEach(() => {
  useSettingsStore.setState(
    {
      ...initialSettings,
      litEnabled: true,
      litSources: { ...initialSettings.litSources, pubmed: true },
    },
    true,
  );
  useLiteratureStore.setState(initialLiterature, true);
});

describe('LiteraturePanel', () => {
  it('states the privacy promise above the query, in the ADR-028 wording', () => {
    render(wrap(<LiteraturePanel />));
    expect(screen.getByText(/never your document, your excerpts, or your prompts/i)).toBeVisible();
  });

  it('shows progress and disables the button while drafting', async () => {
    const pending = deferred<SelectionInfo>();
    setServices({
      office: stubOffice(pending.promise) as OfficeService,
      ollama: { generate: () => noTokens() } as unknown as OllamaClient,
    });

    render(wrap(<LiteraturePanel />));
    const button = screen.getByRole('button', { name: /draft a query/i });
    await userEvent.click(button);

    // Mid-flight: the user must be able to tell this from a dead button.
    await waitFor(() => {
      expect(screen.getByText(/nothing has been sent/i)).toBeVisible();
    });
    expect(screen.getByRole('button', { name: /reading your selection/i })).toBeDisabled();

    // Settle before the test ends, or the resolution lands outside act().
    pending.resolve({ text: 'a passage', isEmpty: false });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /draft a query/i })).toBeEnabled();
    });
  });

  it('offers a Cancel button only while something is in flight, and stops it', async () => {
    const pending = deferred<SelectionInfo>();
    setServices({
      office: stubOffice(pending.promise) as OfficeService,
      ollama: { generate: () => noTokens() } as unknown as OllamaClient,
    });

    render(wrap(<LiteraturePanel />));
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /draft a query/i }));
    const cancelButton = await screen.findByRole('button', { name: /^cancel$/i });
    await userEvent.click(cancelButton);

    // Idle, and specifically not the error phase: the user asked for this.
    expect(useLiteratureStore.getState().phase).toBe('idle');
    expect(useLiteratureStore.getState().error).toBeNull();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();

    // Settle before the test ends, or the resolution lands outside act().
    pending.resolve({ text: 'a passage', isEmpty: false });
    await waitFor(() => {
      expect(useLiteratureStore.getState().phase).toBe('idle');
    });
  });

  it('asks for a selection rather than searching an empty passage', async () => {
    setServices({
      office: stubOffice(Promise.resolve({ text: '   ', isEmpty: true })) as OfficeService,
    });

    render(wrap(<LiteraturePanel />));
    await userEvent.click(screen.getByRole('button', { name: /draft a query/i }));

    await waitFor(() => {
      expect(screen.getByText(/select the passage/i)).toBeVisible();
    });
  });

  it('will not offer to search when no source is turned on', () => {
    useSettingsStore.setState({
      litSources: {
        pubmed: false,
        biorxiv: false,
        medrxiv: false,
        openalex: false,
      },
    });

    render(wrap(<LiteraturePanel />));
    expect(screen.getByText(/no sources are turned on/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /^search$/i })).toBeDisabled();
  });

  it('refuses to send a query over the character cap', () => {
    useLiteratureStore.setState({ draft: 'a'.repeat(300), phase: 'ready' });

    render(wrap(<LiteraturePanel />));
    expect(screen.getByRole('button', { name: /^search$/i })).toBeDisabled();
    expect(screen.getByText(/shorten to 256 or fewer/i)).toBeVisible();
  });
});
