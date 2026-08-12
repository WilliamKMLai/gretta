/**
 * Which model reads images, and whether it actually can (DECISIONS.md ADR-034).
 *
 * One resolver, consumed by both ChatView (to decide what to tell the user when
 * they attach something) and useGeneration (to decide where to send the run).
 * Two callers answering this question separately is how they end up disagreeing:
 * a pane that says the image will be sent and a request that quietly drops it.
 *
 * `visionModel` is null for most people, meaning "use the general model", so the
 * usual resolution is a single `/api/show` on the model already selected. The
 * probe is cached forever per tag (useModelDetails) — capabilities cannot change
 * under a fixed tag, and re-asking on every keystroke would be absurd.
 *
 * The unknown case matters as much as the two known ones. While the probe is in
 * flight, or when Ollama cannot be reached, the honest answer is "we don't know
 * yet" — not "no". Rendering a "your model can't see images" warning during a
 * 200ms probe would be a lie that appears on every fresh load.
 */
import { useSettingsStore } from '../settings';
import { useModelDetails } from '../../hooks/useOllamaQueries';

/** Capability flag Ollama reports for models that accept images. */
export const VISION_CAPABILITY = 'vision';

export interface VisionModelState {
  /** The model a run carrying images should go to; null when none is chosen. */
  model: string | null;
  /** True only when the probe came back and said so. */
  supportsVision: boolean;
  /** The probe hasn't answered yet — neither `supportsVision` nor its negation. */
  isResolving: boolean;
  /**
   * True when the vision model differs from the general one, so an image run
   * will make Ollama swap models. Callers surface this as a latency warning
   * rather than a problem.
   */
  isSeparateModel: boolean;
  /** Why images can't be sent, or null when they can. UI copy, already phrased. */
  reason: string | null;
}

export function useVisionModel(): VisionModelState {
  const defaultModel = useSettingsStore((state) => state.defaultModel);
  const visionModel = useSettingsStore((state) => state.visionModel);

  const model = visionModel ?? defaultModel;
  const details = useModelDetails(model);
  const supportsVision = details.data?.capabilities.includes(VISION_CAPABILITY) ?? false;
  const isResolving = model !== null && details.isPending;

  return {
    model,
    supportsVision,
    isResolving,
    isSeparateModel: visionModel !== null && visionModel !== defaultModel,
    reason: describeProblem({ model, supportsVision, isResolving, failed: details.isError }),
  };
}

function describeProblem(state: {
  model: string | null;
  supportsVision: boolean;
  isResolving: boolean;
  failed: boolean;
}): string | null {
  if (state.model === null) return 'Pick a model first.';
  // Still asking, or we couldn't ask. Either way the attachment is allowed
  // through: sending an image to a model that ignores it wastes a request,
  // while blocking on an unreachable daemon blocks the feature outright.
  if (state.isResolving || state.failed) return null;
  if (state.supportsVision) return null;
  // Attributed to Ollama on purpose. A model family being multimodal says
  // nothing about whether the local build is — a converted build commonly
  // arrives without the vision tower, and Ollama refuses the image itself.
  // "GRETTA thinks your model can't see" invites an argument; "Ollama reports"
  // points at the thing that would actually reject the request.
  return `Ollama reports that ${state.model} can't read images. Pick a vision model in Settings to send this.`;
}
