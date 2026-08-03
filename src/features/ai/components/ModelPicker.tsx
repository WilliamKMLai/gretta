/**
 * Header model selector (ARCHITECTURE.md §10). Reads the installed models
 * from the server cache and binds the choice to settings.defaultModel — one
 * persisted source of truth for "the current model". Loading, error, and
 * empty states are explicit (Phase 6 exit item).
 */
import type { ReactElement } from 'react';
import { Dropdown, Option, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useSettingsStore } from '../../settings';
import { useModels } from '../../../hooks/useOllamaQueries';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  dropdown: { minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
  error: { color: tokens.colorPaletteRedForeground1 },
});

export function ModelPicker(): ReactElement {
  const styles = useStyles();
  const models = useModels();
  const selected = useSettingsStore((state) => state.defaultModel);
  const setSettings = useSettingsStore((state) => state.setSettings);

  const placeholder = models.isPending
    ? 'Loading models…'
    : models.isError
      ? 'Ollama unreachable'
      : models.data.length === 0
        ? 'No models installed'
        : 'Select a model';

  return (
    <div className={styles.root}>
      <Dropdown
        className={styles.dropdown}
        aria-label="Model"
        placeholder={placeholder}
        disabled={models.isPending || models.isError || models.data.length === 0}
        value={selected ?? ''}
        selectedOptions={selected === null ? [] : [selected]}
        onOptionSelect={(_, data) => {
          if (typeof data.optionValue === 'string') {
            setSettings({ defaultModel: data.optionValue });
          }
        }}
        {...(models.isPending ? { expandIcon: <Spinner size="extra-tiny" /> } : {})}
      >
        {(models.data ?? []).map((model) => (
          <Option key={model.name} value={model.name} text={model.name}>
            {model.name}
            {model.parameterSize === null ? '' : ` · ${model.parameterSize}`}
          </Option>
        ))}
      </Dropdown>
      {models.isError ? (
        <Text size={200} className={styles.error}>
          Can't load models — check the connection banner.
        </Text>
      ) : (models.data?.length ?? 0) === 0 && !models.isPending ? (
        <Text size={200} className={styles.hint}>
          Install one with `ollama pull llama3.1:8b`.
        </Text>
      ) : null}
    </div>
  );
}
