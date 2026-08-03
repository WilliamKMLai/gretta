/**
 * Document-binding tests (ADR-020). The binding must live in the document via
 * the office seam, so that both patterns hold without any app-level state: one
 * document using its own collection, and any number of related documents
 * sharing a single collection.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MockOfficeService } from '../../services/office';
import { getServices, setServices } from '../../app/services';
import { KB_BINDING_KEY, useKnowledgeBaseStore } from './knowledgebase.store';
import { useDocumentBinding } from './useDocumentBinding';

beforeEach(() => {
  setServices({ office: new MockOfficeService({}) });
  useKnowledgeBaseStore.setState({ boundCollectionIds: [], bindingLoaded: false, progress: {} });
});

describe('useDocumentBinding', () => {
  it('starts unbound when the document carries no setting', async () => {
    const { result } = renderHook(() => useDocumentBinding());
    await waitFor(() => {
      expect(result.current.bindingLoaded).toBe(true);
    });
    expect(result.current.boundCollectionIds).toEqual([]);
  });

  it('reads an existing binding out of the document', async () => {
    await getServices().office.setDocumentSetting(KB_BINDING_KEY, JSON.stringify(['refs']));
    const { result } = renderHook(() => useDocumentBinding());
    await waitFor(() => {
      expect(result.current.boundCollectionIds).toEqual(['refs']);
    });
  });

  it('ignores a corrupt binding value instead of throwing', async () => {
    await getServices().office.setDocumentSetting(KB_BINDING_KEY, '{not json');
    const { result } = renderHook(() => useDocumentBinding());
    await waitFor(() => {
      expect(result.current.bindingLoaded).toBe(true);
    });
    expect(result.current.boundCollectionIds).toEqual([]);
  });

  it('persists a newly bound collection into the document', async () => {
    const { result } = renderHook(() => useDocumentBinding());
    await waitFor(() => {
      expect(result.current.bindingLoaded).toBe(true);
    });
    await act(async () => {
      await result.current.toggleCollection('refs', true);
    });
    expect(result.current.boundCollectionIds).toEqual(['refs']);
    expect(await getServices().office.getDocumentSetting(KB_BINDING_KEY)).toBe('["refs"]');
  });

  it('clears the document setting when the last collection is unbound', async () => {
    await getServices().office.setDocumentSetting(KB_BINDING_KEY, JSON.stringify(['refs']));
    const { result } = renderHook(() => useDocumentBinding());
    await waitFor(() => {
      expect(result.current.boundCollectionIds).toEqual(['refs']);
    });
    await act(async () => {
      await result.current.toggleCollection('refs', false);
    });
    expect(result.current.boundCollectionIds).toEqual([]);
    expect(await getServices().office.getDocumentSetting(KB_BINDING_KEY)).toBeNull();
  });

  it('does not duplicate an already-bound collection', async () => {
    const { result } = renderHook(() => useDocumentBinding());
    await waitFor(() => {
      expect(result.current.bindingLoaded).toBe(true);
    });
    await act(async () => {
      await result.current.toggleCollection('refs', true);
      await result.current.toggleCollection('refs', true);
    });
    expect(result.current.boundCollectionIds).toEqual(['refs']);
  });
});
