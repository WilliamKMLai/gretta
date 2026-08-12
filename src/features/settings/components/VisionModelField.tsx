/**
 * The vision-model picker and its live capability line (ADR-034).
 *
 * Sits directly under "Default model" rather than in a section of its own,
 * because it is a qualifier on that choice — "and when there's a picture, use
 * this instead" — and a user looking for it will look where models are.
 *
 * Its own file rather than more lines in ConnectionSection: the capability
 * readout is real logic with three states, and burying it in a component that
 * also owns URL validation and the connection test is how that file grows past
 * the point anyone can scan it.
 *
 * The hint is the whole point of the field. A dropdown alone would let someone
 * select a text-only model and discover the problem later, from a model that
 * answers as though the image were not there; probing `/api/show` means the
 * panel can say so at the moment of choosing.
 */
import type { ReactElement } from 'react';
import { Field, Select } from '@fluentui/react-components';
import { useModelDetails, useModels } from '../../../hooks/useOllamaQueries';
import { VISION_CAPABILITY } from '../../ai';
import type { UseSettingsFormResult } from '../useSettingsForm';

/** Placeholder shown while `/api/show` is in flight — never a false negative. */
const CHECKING = 'Checking whether this model can read images…';

/**
 * Explains a missing `vision` capability.
 *
 * The distinction this draws is the one that actually confuses people: a model
 * *family* being multimodal says nothing about whether the local build is. A
 * `safetensors` model was imported or converted on this machine rather than
 * pulled from the library, and such builds routinely arrive without the vision
 * tower — Ollama then refuses images outright with "this model does not support
 * image input". Naming that is the difference between a user thinking GRETTA is
 * wrong about their model and knowing to pull the library build instead.
 */
function explainNoVision(model: string, format: string | null): string {
  const suffix =
    format === 'safetensors'
      ? ` This looks like a locally imported build — the library version may include vision where this one doesn't.`
      : ` Pick a vision model here (e.g. qwen2.5vl, llama3.2-vision) to enable figures.`;
  return `⚠ Ollama reports that ${model} can't read images.${suffix}`;
}

function describeCapability(
  effectiveModel: string,
  details: ReturnType<typeof useModelDetails>,
): string {
  if (effectiveModel === '') return 'Pick a default model first, or choose a vision model here.';
  if (details.isPending) return CHECKING;
  // An unreachable daemon is not evidence about the model. Saying "can't read
  // images" here would be a confident claim built on no information.
  if (details.isError) return `Could not check ${effectiveModel} — is Ollama running?`;
  return details.data.capabilities.includes(VISION_CAPABILITY)
    ? `✓ ${effectiveModel} can read images.`
    : explainNoVision(effectiveModel, details.data.format);
}

/** Only the two form handles this field touches — `resetForm` is the panel's. */
export type VisionModelFieldProps = Pick<UseSettingsFormResult, 'form' | 'setAndCommit'>;

export function VisionModelField({ form, setAndCommit }: VisionModelFieldProps): ReactElement {
  const { watch } = form;
  const models = useModels();
  const installed = models.data ?? [];

  const visionModel = watch('visionModel');
  const defaultModel = watch('defaultModel');
  const effectiveModel = visionModel === '' ? defaultModel : visionModel;

  const details = useModelDetails(effectiveModel === '' ? null : effectiveModel);
  const missingSelection =
    visionModel !== '' && !models.isLoading && !installed.some((m) => m.name === visionModel);

  return (
    <Field
      label="Vision model"
      hint={
        missingSelection
          ? `${visionModel} is not installed on this server — pull it or pick another.`
          : describeCapability(effectiveModel, details)
      }
    >
      <Select
        value={visionModel}
        disabled={models.isLoading}
        onChange={(_, data) => {
          setAndCommit('visionModel', data.value);
        }}
      >
        <option value="">Same as the default model</option>
        {missingSelection && <option value={visionModel}>{visionModel} (not installed)</option>}
        {installed.map((model) => (
          <option key={model.name} value={model.name}>
            {model.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}
