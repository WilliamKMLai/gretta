/**
 * Settings form wiring (ADR-016). Owns the RHF instance, commits each field
 * to the store as soon as *that field* is valid, and keeps the form in sync
 * when the store changes underneath it (Reset to defaults, or the header
 * ModelPicker writing `defaultModel`).
 *
 * Commit-on-change rather than commit-on-submit is deliberate: Phase 6
 * established that settings hot-apply — the Ollama client reads the URL at
 * call time and the theme hook reads the store — and Phase 9's exit criterion
 * is that a URL change *immediately* re-drives the health and model queries.
 * A Save button would break that. What Phase 9 adds is the guarantee that an
 * invalid value never reaches the store at all.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import type { PathValue, UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useSettingsStore } from './settings.store';
import {
  settingsFormSchema,
  toFormValues,
  toPatch,
  type SettingsFieldName,
  type SettingsFormValues,
} from './settings.schema';

export interface UseSettingsFormResult {
  form: UseFormReturn<SettingsFormValues>;
  /** Validates one field and commits it to the store when it passes. */
  commit: (name: SettingsFieldName) => void;
  /** Sets a field and commits in one step — for Slider/Switch/Radio. */
  setAndCommit: <K extends SettingsFieldName>(
    name: K,
    value: PathValue<SettingsFormValues, K>,
  ) => void;
  /**
   * Re-reads every field from the store, discarding uncommitted edits. The
   * field-precise subscription below cannot do this on its own: an abandoned
   * edit never reached the store, so "Reset to defaults" leaves that field's
   * store value unchanged and the stale text would survive on screen. The
   * button knows the user's intent, so the button says so.
   */
  resetForm: () => void;
}

export function useSettingsForm(): UseSettingsFormResult {
  const setSettings = useSettingsStore((state) => state.setSettings);
  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: toFormValues(useSettingsStore.getState()),
    mode: 'onChange',
  });
  const { getValues, setValue, reset, trigger } = form;

  // Guards the store subscription below: a commit we just made must not
  // bounce back and reset the field the user is still editing.
  const committing = useRef(false);

  const commit = useCallback(
    (name: SettingsFieldName) => {
      const patch = toPatch(name, getValues(name));
      void trigger(name);
      if (patch === null) return;
      committing.current = true;
      setSettings(patch);
      committing.current = false;
    },
    [getValues, setSettings, trigger],
  );

  const setAndCommit = useCallback(
    <K extends SettingsFieldName>(name: K, value: PathValue<SettingsFormValues, K>): void => {
      setValue(name, value, { shouldValidate: true });
      commit(name);
    },
    [commit, setValue],
  );

  // Store → form for changes this form didn't originate: Reset to defaults, or
  // the header ModelPicker writing `defaultModel` while Settings is open. Only
  // the fields that actually changed are written back — a blanket reset() would
  // discard whatever the user is mid-way through typing in an unrelated field.
  useEffect(
    () =>
      useSettingsStore.subscribe((state, previous) => {
        if (committing.current) return;
        const next = toFormValues(state);
        const before = toFormValues(previous);
        for (const name of Object.keys(next) as SettingsFieldName[]) {
          if (next[name] === before[name]) continue;
          setValue(name, next[name], { shouldValidate: true });
        }
      }),
    [setValue],
  );

  const resetForm = useCallback(() => {
    reset(toFormValues(useSettingsStore.getState()));
  }, [reset]);

  return { form, commit, setAndCommit, resetForm };
}
