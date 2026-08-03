/**
 * Public surface of services/knowledgebase. Other layers import from here only
 * (`boundaries/entry-point`, ARCHITECTURE.md §5.2).
 */
export type { HttpTransport, KnowledgeBaseClient, KnowledgeBaseClientConfig } from './client.types';
export { createKnowledgeBaseClient } from './client';
