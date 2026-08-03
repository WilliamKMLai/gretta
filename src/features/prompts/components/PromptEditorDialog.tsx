/**
 * Create/edit dialog for custom prompt templates (ROADMAP Phase 8): React
 * Hook Form + Zod resolver, live `{{var}}` validation via unknownPlaceholders
 * (typos and `{{ spaced }}` tokens are named in the error), a live preview
 * interpolated with sample values, and Delete when editing. Built-ins are
 * never editable — the picker only routes custom ids here. Saving a new
 * prompt also selects it.
 */
import { useEffect, useMemo } from 'react';
import type { ReactElement } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Button,
  Caption1,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Label,
  Select,
  SpinButton,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import { useAppToasts } from '../../../components/toaster';
import type { PromptContextVar } from '../../../types/domain';
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../builtins';
import { usePromptsStore, type CustomPromptInput } from '../prompts.store';
import { KNOWN_VARS, applyTemplate, referencedVars, unknownPlaceholders } from '../template';

/** Stand-in values the live preview interpolates with. */
const SAMPLE_VARS: Record<PromptContextVar, string> = {
  selection: '[selected text]',
  paragraph: '[current paragraph]',
  document: '[document text]',
  input: '[your typed prompt]',
};

const noTypoPlaceholders = (value: string, ctx: z.RefinementCtx): void => {
  const bad = unknownPlaceholders(value);
  if (bad.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `Unknown placeholder${bad.length > 1 ? 's' : ''}: ${bad
        .map((name) => `{{${name}}}`)
        .join(', ')}`,
    });
  }
};

const formSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.'),
  category: z.enum(['scientific', 'editing', 'style', 'grants', 'communication', 'custom']),
  description: z.string(),
  system: z.string().superRefine(noTypoPlaceholders),
  user: z.string().trim().min(1, 'The user template is required.').superRefine(noTypoPlaceholders),
  requires: z.array(z.enum(['selection', 'paragraph', 'document', 'input'])),
  temperature: z
    .number('Temperature must be a number.')
    .min(0, 'Temperature is 0–2.')
    .max(2, 'Temperature is 0–2.')
    .nullable(),
});

type FormValues = z.infer<typeof formSchema>;

const EMPTY: FormValues = {
  name: '',
  category: 'custom',
  description: '',
  system: '',
  user: '',
  requires: [],
  temperature: null,
};

const useStyles = makeStyles({
  surface: { width: 'min(480px, 94vw)' },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  preview: {
    whiteSpace: 'pre-wrap',
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalS,
    maxHeight: '120px',
    overflowY: 'auto',
  },
  deleteAction: { marginRight: 'auto' },
});

export interface PromptEditorDialogProps {
  open: boolean;
  /** Custom prompt id to edit, or null to create. */
  promptId: string | null;
  onDismiss: () => void;
}

export function PromptEditorDialog({
  open,
  promptId,
  onDismiss,
}: PromptEditorDialogProps): ReactElement {
  const styles = useStyles();
  const toasts = useAppToasts();
  const customPrompts = usePromptsStore((state) => state.customPrompts);
  const addCustomPrompt = usePromptsStore((state) => state.addCustomPrompt);
  const updateCustomPrompt = usePromptsStore((state) => state.updateCustomPrompt);
  const deleteCustomPrompt = usePromptsStore((state) => state.deleteCustomPrompt);
  const setSelectedPrompt = usePromptsStore((state) => state.setSelectedPrompt);

  const { control, handleSubmit, register, reset, watch, formState } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: EMPTY,
    mode: 'onChange',
  });

  // (Re)load whenever the dialog opens: the target's fields, or a blank form.
  useEffect(() => {
    if (!open) return;
    const target = customPrompts.find((prompt) => prompt.id === promptId);
    reset(
      target === undefined
        ? EMPTY
        : {
            name: target.name,
            category: target.category,
            description: target.description,
            system: target.system,
            user: target.user,
            requires: [...target.requires],
            temperature: target.defaults?.temperature ?? null,
          },
    );
    // customPrompts is intentionally omitted: mid-edit store changes must not clobber typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, promptId, reset]);

  const systemText = watch('system');
  const userText = watch('user');
  const referenced = useMemo(
    () => referencedVars(`${systemText}\n${userText}`),
    [systemText, userText],
  );
  const preview = useMemo(() => {
    const system = applyTemplate(systemText, SAMPLE_VARS).trim();
    const user = applyTemplate(userText, SAMPLE_VARS);
    return system === '' ? user : `[system]\n${system}\n\n[user]\n${user}`;
  }, [systemText, userText]);

  const onSubmit = (values: FormValues): void => {
    const input: CustomPromptInput = {
      name: values.name,
      category: values.category,
      description: values.description,
      system: values.system,
      user: values.user,
      requires: values.requires,
      ...(values.temperature === null ? {} : { defaults: { temperature: values.temperature } }),
    };
    if (promptId === null) {
      setSelectedPrompt(addCustomPrompt(input));
      toasts.success('Prompt created');
    } else {
      updateCustomPrompt(promptId, input);
      toasts.success('Prompt saved');
    }
    onDismiss();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) onDismiss();
      }}
    >
      <DialogSurface className={styles.surface}>
        <form
          onSubmit={(event) => {
            void handleSubmit(onSubmit)(event);
          }}
        >
          <DialogBody>
            <DialogTitle>{promptId === null ? 'New prompt' : 'Edit prompt'}</DialogTitle>
            <DialogContent className={styles.form}>
              <Field
                label="Name"
                required
                validationMessage={formState.errors.name?.message ?? null}
              >
                <Input {...register('name')} />
              </Field>
              <Field label="Category">
                <Select {...register('category')}>
                  {CATEGORY_ORDER.map((category) => (
                    <option key={category} value={category}>
                      {CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Description">
                <Input {...register('description')} />
              </Field>
              <Field
                label="System prompt"
                validationMessage={formState.errors.system?.message ?? null}
              >
                <Textarea rows={3} resize="vertical" {...register('system')} />
              </Field>
              <Field
                label="User template"
                required
                validationMessage={formState.errors.user?.message ?? null}
                hint={`Placeholders: ${KNOWN_VARS.map((name) => `{{${name}}}`).join(' ')}`}
              >
                <Textarea rows={3} resize="vertical" {...register('user')} />
              </Field>
              <div>
                <Label>Requires before running</Label>
                <Controller
                  control={control}
                  name="requires"
                  render={({ field }) => (
                    <div role="group" aria-label="Required context">
                      {KNOWN_VARS.map((variable) => (
                        <Checkbox
                          key={variable}
                          label={variable}
                          checked={field.value.includes(variable)}
                          onChange={(_, data) => {
                            field.onChange(
                              data.checked === true
                                ? [...field.value, variable]
                                : field.value.filter((entry) => entry !== variable),
                            );
                          }}
                        />
                      ))}
                    </div>
                  )}
                />
              </div>
              <Field
                label="Temperature default (optional)"
                validationMessage={formState.errors.temperature?.message ?? null}
                hint="Leave empty to follow Settings."
              >
                <Controller
                  control={control}
                  name="temperature"
                  render={({ field }) => (
                    <SpinButton
                      min={0}
                      max={2}
                      step={0.1}
                      value={field.value}
                      onChange={(_, data) => {
                        field.onChange(data.value ?? null);
                      }}
                    />
                  )}
                />
              </Field>
              <Caption1>
                {referenced.length === 0
                  ? 'No placeholders referenced yet.'
                  : `References: ${referenced.join(', ')}`}
              </Caption1>
              <Field label="Preview (sample values)">
                <div className={styles.preview}>{preview}</div>
              </Field>
            </DialogContent>
            <DialogActions>
              {promptId !== null && (
                <Button
                  className={styles.deleteAction}
                  appearance="subtle"
                  icon={<DeleteRegular />}
                  onClick={() => {
                    deleteCustomPrompt(promptId);
                    toasts.success('Prompt deleted');
                    onDismiss();
                  }}
                >
                  Delete
                </Button>
              )}
              <Button appearance="secondary" onClick={onDismiss}>
                Cancel
              </Button>
              <Button appearance="primary" type="submit" disabled={!formState.isValid}>
                {promptId === null ? 'Create' : 'Save'}
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
