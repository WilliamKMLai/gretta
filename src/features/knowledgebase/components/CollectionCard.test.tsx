/**
 * CollectionCard tests focused on the over-capacity warning (ADR-020): the
 * ceiling is advisory, so the card must say so rather than silently degrade.
 */
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { render, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CollectionStatus } from '../../../types/knowledgebase';
import { CollectionCard } from './CollectionCard';

const baseCollection: CollectionStatus = {
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

function wrap(children: ReactNode): ReactElement {
  return <FluentProvider theme={webLightTheme}>{children}</FluentProvider>;
}

function renderCard(collection: CollectionStatus): void {
  render(
    wrap(
      <CollectionCard
        collection={collection}
        bound={false}
        bindingLoaded
        models={['nomic-embed-text']}
        onToggleBound={vi.fn()}
        onReindex={vi.fn()}
        onDelete={vi.fn()}
        onSave={vi.fn()}
      />,
    ),
  );
}

describe('CollectionCard', () => {
  it('renders no warning for a collection under the ceiling', () => {
    renderCard(baseCollection);
    expect(
      screen.queryByText(/past the size the fast index is tuned for/i),
    ).not.toBeInTheDocument();
  });

  it('warns when a collection is over the ceiling, and still shows the honest percentage', () => {
    renderCard({ ...baseCollection, chunkCount: 100_000, capacityPct: 333, overCapacity: true });
    expect(screen.getByText(/past the size the fast index is tuned for/i)).toBeInTheDocument();
    expect(screen.getByText(/333% of 30,000/)).toBeInTheDocument();
  });

  it('never truncates the stats — file and excerpt counts still render when over capacity', () => {
    renderCard({
      ...baseCollection,
      fileCount: 500,
      chunkCount: 100_000,
      capacityPct: 333,
      overCapacity: true,
    });
    expect(screen.getByText('500 files')).toBeInTheDocument();
    expect(screen.getByText('100,000 excerpts')).toBeInTheDocument();
  });
});
