/**
 * Public surface of services/ollama. Other layers import from here only
 * (mechanical enforcement lands with the Phase 5 entry-point rule).
 */
export type {
  ChatRequest,
  GenerateRequest,
  HttpTransport,
  OllamaClient,
  OllamaModel,
  OllamaModelDetails,
  OllamaOptions,
  StreamEvent,
} from './client.types';
export { createOllamaClient, type OllamaClientConfig } from './client';
export { defaultTransport } from './transport';
export { diagnoseConnection, type ConnectionDiagnosis, type DiagnoseArgs } from './diagnostics';
export { DIRECT_URL, MAC_PROXY_URL, findOllama } from './autoDetect';
export type { ProbeResult } from './autoDetect';
