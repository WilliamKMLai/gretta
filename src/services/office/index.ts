/**
 * Public surface of services/office. Other layers import from here only.
 * (`boundaries/entry-point` starts enforcing that mechanically in Phase 5;
 * until then it's convention.)
 */
import { MockOfficeService, SAMPLE_DOCUMENT_TEXT } from './office.mock';
import { WordOfficeService } from './office.service';
import type { HostInfo, OfficeService } from './office.types';

export type {
  HighlightColor,
  HostInfo,
  OfficeService,
  OfficeThemeKind,
  SelectionInfo,
} from './office.types';
export { detectHostInfo } from './host';
export { WORD_API_BASELINE, WORD_API_COMMENTS } from './requirements';
export { WordOfficeService } from './office.service';
export {
  MockOfficeService,
  SAMPLE_DOCUMENT_TEXT,
  type MockOfficeOptions,
  type MockOfficeState,
} from './office.mock';

/**
 * Chooses the implementation for the detected host: the Word-backed service
 * inside Word, the seeded in-memory mock everywhere else (browser dev mode,
 * jsdom). Phase 5's composition root (app/services.ts, ADR-003) takes over
 * instance ownership; this factory is what it will call.
 */
export function createOfficeService(hostInfo: HostInfo): OfficeService {
  return hostInfo.available
    ? new WordOfficeService(hostInfo)
    : new MockOfficeService({ initialText: SAMPLE_DOCUMENT_TEXT });
}
