/** Embedding-model hints and folder-path validation (ADR-026). */
import { describe, expect, it } from 'vitest';
import {
  describeFolderProblem,
  filterEmbeddingModels,
  looksLikeEmbeddingModel,
} from './embeddingModels';

describe('looksLikeEmbeddingModel', () => {
  it('recognises the common embedding families', () => {
    for (const name of [
      'nomic-embed-text:latest',
      'mxbai-embed-large',
      'bge-m3',
      'all-minilm',
      'snowflake-arctic-embed2',
    ]) {
      expect(looksLikeEmbeddingModel(name)).toBe(true);
    }
  });

  it('rejects chat models', () => {
    for (const name of ['llama3:8b', 'deepseek-r1:32b', 'mistral:7b', 'phi4']) {
      expect(looksLikeEmbeddingModel(name)).toBe(false);
    }
  });
});

describe('filterEmbeddingModels', () => {
  it('narrows a mixed list to the embedding models', () => {
    expect(filterEmbeddingModels(['llama3:8b', 'nomic-embed-text:latest', 'mistral:7b'])).toEqual([
      'nomic-embed-text:latest',
    ]);
  });

  it('falls back to everything rather than showing an empty picker', () => {
    // A hint list is necessarily incomplete; being locked out is worse than
    // being offered a model that may not work.
    expect(filterEmbeddingModels(['some-unusual-model'])).toEqual(['some-unusual-model']);
    expect(filterEmbeddingModels([])).toEqual([]);
  });
});

describe('describeFolderProblem', () => {
  it('accepts absolute paths on either platform', () => {
    expect(describeFolderProblem('/Users/me/Refs')).toBeNull();
    expect(describeFolderProblem('C:\\Users\\me\\Refs')).toBeNull();
    expect(describeFolderProblem('\\\\server\\share')).toBeNull();
  });

  it('asks for a path when empty', () => {
    expect(describeFolderProblem('   ')).toMatch(/absolute path/i);
  });

  it('rejects a relative path', () => {
    expect(describeFolderProblem('Documents/Refs')).toMatch(/full path/i);
  });

  it('rejects an unexpanded home shortcut, which the companion cannot resolve', () => {
    expect(describeFolderProblem('~/Documents')).toMatch(/home folder/i);
  });

  it('catches a pasted line break', () => {
    expect(describeFolderProblem('/Users/me/\nRefs')).toMatch(/line break/i);
  });
});
