/** Public API of the history feature (ADR-021). */
export {
  HISTORY_LIMIT,
  describeRecord,
  useHistoryStore,
  type HistoryState,
  type NewGenerationRecord,
} from './history.store';
export { persistedHistorySchema, type PersistedHistory } from './history.schema';
export { HistoryList } from './components/HistoryList';
export { exportFilename, historyToJson, recordToJson, recordToMarkdown } from './export';
export { CONTEXT_EXCERPT_CHARS, isTruncated, toContextExcerpt } from './contextExcerpt';
