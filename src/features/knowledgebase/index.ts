/**
 * Public surface of features/knowledgebase (ARCHITECTURE.md §5.2 — sibling
 * features import through this barrel only).
 */
export {
  KB_BINDING_KEY,
  describePhase,
  useKnowledgeBaseStore,
  type KnowledgeBaseState,
} from './knowledgebase.store';
export { useDocumentBinding, type UseDocumentBindingResult } from './useDocumentBinding';
export { KnowledgeBasePanel } from './components/KnowledgeBasePanel';
