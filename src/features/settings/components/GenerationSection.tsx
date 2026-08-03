/**
 * Generation settings (ROADMAP Phase 9): temperature, top P, top K, context
 * length, seed. Control bounds come from LIMITS, the same constants the Zod
 * field schemas use, so the slider can't offer a value the schema rejects.
 *
 * Commit rule (ADR-016): constrained controls — slider, spin button — commit
 * on change, because they cannot express an out-of-range value. Free-text
 * fields commit on blur or Enter: validation runs live so the error appears
 * as you type, but a half-typed `12.5` must never land in the store as `12`.
 */
import type { ReactElement } from 'react';
import {
  Field,
  Input,
  Slider,
  SpinButton,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { SpinButtonOnChangeData } from '@fluentui/react-components';
import { LIMITS } from '../settings.schema';
import type { UseSettingsFormResult } from '../useSettingsForm';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  sliderRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  slider: { flexGrow: 1, minWidth: 0 },
  sliderValue: { minWidth: '36px', textAlign: 'right' },
});

/** SpinButton reports either a number or the typed display string. */
function spinValue(data: SpinButtonOnChangeData): number | null {
  if (typeof data.value === 'number') return data.value;
  if (data.displayValue !== undefined) {
    const parsed = Number(data.displayValue);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return null;
}

export function GenerationSection({
  form,
  commit,
  setAndCommit,
}: UseSettingsFormResult): ReactElement {
  const styles = useStyles();
  const {
    formState: { errors },
    setValue,
    watch,
  } = form;

  const temperature = watch('temperature');
  const topP = watch('topP');

  return (
    <div className={styles.section}>
      <Field
        label={`Temperature — ${temperature.toFixed(1)}`}
        validationMessage={errors.temperature?.message ?? null}
        hint="Lower is more literal and repeatable; higher gives the model more room."
      >
        <div className={styles.sliderRow}>
          <Slider
            className={styles.slider}
            min={LIMITS.temperature.min}
            max={LIMITS.temperature.max}
            step={LIMITS.temperature.step}
            value={temperature}
            onChange={(_, data) => {
              setAndCommit('temperature', Math.round(data.value * 10) / 10);
            }}
            aria-label="Temperature"
          />
          <Text size={200} className={styles.sliderValue}>
            {temperature.toFixed(1)}
          </Text>
        </div>
      </Field>

      <Field label={`Top P — ${topP.toFixed(2)}`} validationMessage={errors.topP?.message ?? null}>
        <div className={styles.sliderRow}>
          <Slider
            className={styles.slider}
            min={LIMITS.topP.min}
            max={LIMITS.topP.max}
            step={LIMITS.topP.step}
            value={topP}
            onChange={(_, data) => {
              setAndCommit('topP', Math.round(data.value * 100) / 100);
            }}
            aria-label="Top P"
          />
          <Text size={200} className={styles.sliderValue}>
            {topP.toFixed(2)}
          </Text>
        </div>
      </Field>

      <Field label="Top K" validationMessage={errors.topK?.message ?? null}>
        <SpinButton
          min={LIMITS.topK.min}
          max={LIMITS.topK.max}
          step={LIMITS.topK.step}
          value={watch('topK')}
          onChange={(_, data) => {
            const value = spinValue(data);
            if (value !== null) setAndCommit('topK', value);
          }}
        />
      </Field>

      <Field
        label="Context length (tokens)"
        validationMessage={errors.contextLength?.message ?? null}
        hint="Ollama num_ctx; higher uses more RAM."
      >
        <SpinButton
          min={LIMITS.contextLength.min}
          max={LIMITS.contextLength.max}
          step={LIMITS.contextLength.step}
          value={watch('contextLength')}
          onChange={(_, data) => {
            const value = spinValue(data);
            if (value !== null) setAndCommit('contextLength', value);
          }}
        />
      </Field>

      <Field
        label="Reserved for the reply (%)"
        validationMessage={errors.responseReservePct?.message ?? null}
        hint="The context length covers the prompt and the reply together. This share is held back so a long prompt cannot crowd out the answer."
      >
        <SpinButton
          min={5}
          max={60}
          step={5}
          value={watch('responseReservePct')}
          onChange={(_, data) => {
            const value = spinValue(data);
            if (value !== null) setAndCommit('responseReservePct', value);
          }}
        />
      </Field>

      <Field
        label="Seed"
        validationMessage={errors.seed?.message ?? null}
        hint="Blank = random each time. A fixed seed makes repeat runs more consistent but does not guarantee identical output — the first run after a model loads often differs, and parallel math, hardware, quantization, or an Ollama/llama.cpp update can all change the result."
      >
        <Input
          type="text"
          inputMode="numeric"
          placeholder="Random"
          value={watch('seed')}
          onChange={(_, data) => {
            setValue('seed', data.value, { shouldValidate: true });
          }}
          onBlur={() => {
            commit('seed');
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit('seed');
          }}
        />
      </Field>
    </div>
  );
}
