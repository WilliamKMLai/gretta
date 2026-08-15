/**
 * Panel tests focused on the scope question the UI has to answer: what does
 * ticking the box actually do, and to what? (ADR-020)
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getServices, setServices } from '../../../app/services';
import { MockOfficeService } from '../../../services/office';
import type { KnowledgeBaseClient } from '../../../services/knowledgebase';
import type { OllamaClient } from '../../../services/ollama';
import type { CollectionStatus } from '../../../types/knowledgebase';
import { useSettingsStore } from '../../settings';
import { KB_BINDING_KEY, useKnowledgeBaseStore } from '../knowledgebase.store';
import { KnowledgeBasePanel } from './KnowledgeBasePanel';

const collection: CollectionStatus = {
  id: 'refs',
  name: 'Reference library',
  folders: ['/Users/me/Refs'],
  embeddingModel: 'nomic-embed-text',
  phase: 'ready',
  fileCount: 12,
  chunkCount: 300,
  maxChunks: 30_000,
  capacityPct: 1,
  overCapacity: false,
  skipped: [],
  lastIndexedAt: '2026-07-22T00:00:00.000Z',
  message: null,
  indexFigures: false,
  figureCount: 0,
  describedFigureCount: 0,
};

const stubKb = (overrides: Partial<KnowledgeBaseClient> = {}): KnowledgeBaseClient => ({
  health: () => Promise.resolve({ name: 'gretta-kb', version: '1.0.0', ok: true }),
  listCollections: () => Promise.resolve([collection]),
  upsertCollection: () => Promise.resolve(collection),
  deleteCollection: () => Promise.resolve(),
  reindexCollection: () => Promise.resolve(collection),
  getFigure: vi.fn(() => Promise.resolve(null)),
  pickFolder: () => Promise.resolve({ ok: false, reason: 'unsupported' as const }),
  query: () => Promise.resolve([]),
  ...overrides,
});

function wrap(children: ReactNode): ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <FluentProvider theme={webLightTheme}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </FluentProvider>
  );
}

const stubOllama = (): OllamaClient =>
  ({
    listModels: () =>
      Promise.resolve([
        {
          name: 'nomic-embed-text',
          size: 1,
          modifiedAt: '',
          parameterSize: null,
          quantization: null,
        },
        {
          name: 'mxbai-embed-large',
          size: 1,
          modifiedAt: '',
          parameterSize: null,
          quantization: null,
        },
      ]),
    health: () => Promise.resolve({ version: '0.0.0' }),
  }) as unknown as OllamaClient;

beforeEach(() => {
  setServices({ kb: stubKb(), office: new MockOfficeService({}), ollama: stubOllama() });
  useKnowledgeBaseStore.setState({ boundCollectionIds: [], bindingLoaded: false, progress: {} });
  useSettingsStore.setState({ kbEnabled: true, defaultEmbeddingModel: 'nomic-embed-text' });
});

describe('KnowledgeBasePanel', () => {
  it('labels the binding control by what it affects, not by the collection name', async () => {
    render(wrap(<KnowledgeBasePanel />));
    const checkbox = await screen.findByRole('checkbox', { name: /use in this document/i });
    expect(checkbox).toBeInTheDocument();
  });

  it('separates document scope from global collection scope', async () => {
    render(wrap(<KnowledgeBasePanel />));
    expect(await screen.findByText('This document')).toBeInTheDocument();
    expect(screen.getByText('Collections on this computer')).toBeInTheDocument();
  });

  it('says in words that nothing is used when the document is unbound', async () => {
    render(wrap(<KnowledgeBasePanel />));
    expect(await screen.findByText(/not using any knowledge base/i)).toBeInTheDocument();
  });

  it('names the collections in use once the document is bound', async () => {
    await getServices().office.setDocumentSetting(KB_BINDING_KEY, JSON.stringify(['refs']));
    render(wrap(<KnowledgeBasePanel />));
    await waitFor(() => {
      expect(screen.getByText(/using reference library/i)).toBeInTheDocument();
    });
  });

  it('binds the open document when the box is ticked, and says so', async () => {
    render(wrap(<KnowledgeBasePanel />));
    const checkbox = await screen.findByRole('checkbox', { name: /use in this document/i });
    await waitFor(() => {
      expect(checkbox).toBeEnabled();
    });
    await userEvent.click(checkbox);

    await waitFor(() => {
      expect(screen.getByText(/using reference library/i)).toBeInTheDocument();
    });
    // and it is persisted into the document, not just app state
    expect(await getServices().office.getDocumentSetting(KB_BINDING_KEY)).toBe('["refs"]');
  });

  it('explains that the choice is stored in the document', async () => {
    render(wrap(<KnowledgeBasePanel />));
    expect(await screen.findByText(/saved inside the document/i)).toBeInTheDocument();
  });

  it('offers guidance instead of an error when the companion is down', async () => {
    setServices({
      kb: stubKb({ health: () => Promise.reject(new Error('offline')) }),
    });
    render(wrap(<KnowledgeBasePanel />));
    expect(await screen.findByText(/companion not running/i)).toBeInTheDocument();
  });

  it('prompts to enable the feature when it is switched off', async () => {
    useSettingsStore.setState({ kbEnabled: false });
    render(wrap(<KnowledgeBasePanel />));
    // awaited so the binding effect settles inside the test (no act warning)
    expect(await screen.findByText(/knowledge base is off/i)).toBeInTheDocument();
  });

  it('requires confirmation before deleting, and does not delete on cancel', async () => {
    const deleteCollection = vi.fn(() => Promise.resolve());
    setServices({ kb: stubKb({ deleteCollection }) });
    render(wrap(<KnowledgeBasePanel />));

    await userEvent.click(await screen.findByRole('button', { name: /delete reference library/i }));
    expect(await screen.findByText(/delete “reference library”\?/i)).toBeInTheDocument();
    expect(deleteCollection).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(deleteCollection).not.toHaveBeenCalled();
  });

  it('deletes only after the confirmation is accepted', async () => {
    const deleteCollection = vi.fn(() => Promise.resolve());
    setServices({ kb: stubKb({ deleteCollection }) });
    render(wrap(<KnowledgeBasePanel />));

    await userEvent.click(await screen.findByRole('button', { name: /delete reference library/i }));
    await userEvent.click(await screen.findByRole('button', { name: /delete collection/i }));
    await waitFor(() => {
      expect(deleteCollection).toHaveBeenCalledWith('refs');
    });
  });

  it('says what deleting will and will not touch', async () => {
    render(wrap(<KnowledgeBasePanel />));
    await userEvent.click(await screen.findByRole('button', { name: /delete reference library/i }));
    expect(await screen.findByText(/your files are not touched/i)).toBeInTheDocument();
  });

  it('edits a collection while preserving its id, so bindings survive a rename', async () => {
    const upsertCollection = vi.fn(() => Promise.resolve(collection));
    setServices({ kb: stubKb({ upsertCollection }) });
    render(wrap(<KnowledgeBasePanel />));

    await userEvent.click(await screen.findByRole('button', { name: /edit reference library/i }));
    const nameBox = await screen.findByDisplayValue('Reference library');
    await userEvent.clear(nameBox);
    await userEvent.type(nameBox, 'Renamed library');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(upsertCollection).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'refs', name: 'Renamed library' }),
      );
    });
  });

  it('warns that changing the embedding model forces a re-index', async () => {
    render(wrap(<KnowledgeBasePanel />));
    await userEvent.click(await screen.findByRole('button', { name: /edit reference library/i }));
    const select = await screen.findByRole('combobox');
    await userEvent.selectOptions(select, 'mxbai-embed-large');
    expect(await screen.findByText(/re-indexes this collection from scratch/i)).toBeInTheDocument();
  });

  /*
   * Asserted through `aria-expanded` rather than by looking for the fields:
   * Fluent keeps an AccordionPanel's children mounted and merely hides them,
   * so presence in the DOM says nothing about whether anyone can see them.
   */
  it('collapses the add form when collections already exist', async () => {
    // The panel's job once a knowledge base is set up is showing what is in
    // it; the add form is occasional and should not cost that space on every
    // visit.
    render(wrap(<KnowledgeBasePanel />));
    const header = await screen.findByRole('button', { name: /add a collection/i });
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the add form when there are no collections yet', async () => {
    // Adding one is then the only thing to do, and hiding the sole available
    // action behind a click is the opposite of decluttering.
    setServices({ kb: stubKb({ listCollections: () => Promise.resolve([]) }) });
    render(wrap(<KnowledgeBasePanel />));
    const header = await screen.findByRole('button', { name: /add a collection/i });
    expect(header).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens the add form when its header is clicked', async () => {
    render(wrap(<KnowledgeBasePanel />));
    const header = await screen.findByRole('button', { name: /add a collection/i });
    await userEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
  });

  it('marks both new-collection fields as required', async () => {
    // Rendered with no collections so the form is open — this is about what
    // the form says, not about whether it is showing.
    setServices({ kb: stubKb({ listCollections: () => Promise.resolve([]) }) });
    render(wrap(<KnowledgeBasePanel />));
    expect(await screen.findByText(/name and folder are required/i)).toBeInTheDocument();
    expect(screen.getByText(/give the collection a name/i)).toBeInTheDocument();
    expect(screen.getByText(/paste the absolute path/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add collection/i })).toBeDisabled();
  });

  it('reports per-collection statistics', async () => {
    render(wrap(<KnowledgeBasePanel />));
    expect(await screen.findByText('12 files')).toBeInTheDocument();
    expect(screen.getByText('300 excerpts')).toBeInTheDocument();
    expect(screen.getByText('Ready to search')).toBeInTheDocument();
    expect(screen.getByText(/^indexed /i)).toBeInTheDocument();
  });

  it('warns when the document expects a collection this computer lacks', async () => {
    await getServices().office.setDocumentSetting(
      KB_BINDING_KEY,
      JSON.stringify(['refs', 'lab-protocols']),
    );
    render(wrap(<KnowledgeBasePanel />));
    expect(await screen.findByText(/not on this computer/i)).toBeInTheDocument();
    expect(screen.getByText(/lab-protocols/)).toBeInTheDocument();
  });

  it('says nothing about missing collections when every binding resolves', async () => {
    await getServices().office.setDocumentSetting(KB_BINDING_KEY, JSON.stringify(['refs']));
    render(wrap(<KnowledgeBasePanel />));
    await waitFor(() => {
      expect(screen.getByText(/using reference library/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/not on this computer/i)).not.toBeInTheDocument();
  });

  it('explains that collections are matched by name across computers', async () => {
    render(wrap(<KnowledgeBasePanel />));
    expect(await screen.findByText(/matched by name/i)).toBeInTheDocument();
  });

  it('shows capacity against the fast-search limit', async () => {
    render(wrap(<KnowledgeBasePanel />));
    expect(await screen.findByText(/% of 30,000/)).toBeInTheDocument();
  });

  it('does not let the box be toggled before the binding is known', async () => {
    // A binding read that never settles — the pane must not offer the control yet.
    const pending = new Promise<string | null>(() => {
      /* deliberately never resolves */
    });
    vi.spyOn(getServices().office, 'getDocumentSetting').mockReturnValue(pending);
    render(wrap(<KnowledgeBasePanel />));
    const checkbox = await screen.findByRole('checkbox', { name: /use in this document/i });
    expect(checkbox).toBeDisabled();
  });
});
