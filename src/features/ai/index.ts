/** Public API of the ai feature. */
export {
  useStreamStore,
  type StreamRequestMeta,
  type StreamState,
  type StreamStatus,
} from './stream.store';
export { ConnectionBanner } from './components/ConnectionBanner';
export { GenerationControls } from './components/GenerationControls';
export { ModelPicker } from './components/ModelPicker';
export { ResponseView } from './components/ResponseView';
export { abortActiveGeneration, useGeneration, type UseGenerationResult } from './useGeneration';
export { buildChatRequest, type GenerationInput, type RequestSettings } from './request';
export { useVisionModel, VISION_CAPABILITY, type VisionModelState } from './useVisionModel';
export { useAttachmentsStore, MAX_ATTACHMENTS } from './attachments.store';
export { prepareImage, type PreparedImage } from './images';
export { ImageAttachButton } from './components/ImageAttachButton';
export { DocumentFigureButton } from './components/DocumentFigureButton';
export { AttachmentStrip } from './components/AttachmentStrip';
export { useImageAttach, type UseImageAttachResult } from './useImageAttach';
