/**
 * Connection settings (ROADMAP Phase 9): the Ollama URL, the default model
 * fed by the live installed-model list, and "Test connection".
 *
 * The URL commits on blur/Enter rather than per keystroke — the store is what
 * the health poll and every Ollama call read, so committing mid-typing would
 * fire requests at `http://12` — but validation runs live, so the error text
 * appears as you type. A committed URL change re-drives the health and model
 * queries by construction: the client reads the store at call time (§7.2) and
 * the queries below are invalidated here.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Subtitle2,
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Select,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { PlugConnectedRegular } from '@fluentui/react-icons';
import { getServices } from '../../../app/services';
import type { HostInfo } from '../../../services/office';
import { describeOllamaError } from '../../../types/errors';
import { ollamaKeys, useModels } from '../../../hooks/useOllamaQueries';
import type { UseSettingsFormResult } from '../useSettingsForm';

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; version: string; models: number }
  | { status: 'failed'; title: string; body: string };

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  testRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
});

export interface ConnectionSectionProps extends UseSettingsFormResult {
  platform: HostInfo['platform'];
}

export function ConnectionSection({
  form,
  commit,
  setAndCommit,
  platform,
}: ConnectionSectionProps): ReactElement {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const models = useModels();
  const [test, setTest] = useState<TestState>({ status: 'idle' });

  const {
    formState: { errors },
    getValues,
    setValue,
    watch,
  } = form;

  const selectedModel = watch('defaultModel');
  const installed = models.data ?? [];
  // A model that was pulled away still shows, so the setting never looks empty.
  const missingSelection = selectedModel !== '' && !installed.some((m) => m.name === selectedModel);
  const runTest = async (): Promise<void> => {
    setTest({ status: 'testing' });
    try {
      const health = await getServices().ollama.health();
      const list = await getServices().ollama.listModels();
      setTest({ status: 'ok', version: health.version, models: list.length });
      // A successful manual test is the moment to refresh everything the
      // pane caches about the daemon.
      await queryClient.invalidateQueries({ queryKey: ollamaKeys.health });
      await queryClient.invalidateQueries({ queryKey: ollamaKeys.models });
    } catch (error) {
      const guidance = describeOllamaError(error, {
        url: getValues('ollamaUrl'),
        isMac: platform === 'Mac',
      });
      setTest({ status: 'failed', title: guidance.title, body: guidance.body });
    }
  };

  return (
    <div className={styles.section}>
      <Subtitle2>Connection</Subtitle2>
      <Field
        label="Ollama server URL"
        required
        validationMessage={errors.ollamaUrl?.message ?? null}
        hint="Word on Mac blocks plain HTTP — run `pnpm proxy` and use https://localhost:11435."
      >
        <Input
          value={watch('ollamaUrl')}
          onChange={(_, data) => {
            setValue('ollamaUrl', data.value, { shouldValidate: true });
          }}
          onBlur={() => {
            commit('ollamaUrl');
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit('ollamaUrl');
          }}
        />
      </Field>

      <Field
        label="Default model"
        hint={
          missingSelection
            ? `${selectedModel} is not installed on this server — pull it or pick another.`
            : 'Used for new generations; the header picker changes it too.'
        }
      >
        <Select
          value={selectedModel}
          disabled={models.isLoading}
          onChange={(_, data) => {
            setAndCommit('defaultModel', data.value);
          }}
        >
          <option value="">
            {models.isLoading ? 'Loading models…' : 'None — choose in the header'}
          </option>
          {missingSelection && (
            <option value={selectedModel}>{selectedModel} (not installed)</option>
          )}
          {installed.map((model) => (
            <option key={model.name} value={model.name}>
              {model.name}
            </option>
          ))}
        </Select>
      </Field>

      <div className={styles.testRow}>
        <Button
          appearance="secondary"
          icon={test.status === 'testing' ? <Spinner size="tiny" /> : <PlugConnectedRegular />}
          disabled={test.status === 'testing' || errors.ollamaUrl !== undefined}
          onClick={() => {
            void runTest();
          }}
        >
          Test connection
        </Button>
      </div>

      {test.status === 'ok' && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>Connected to Ollama {test.version}</MessageBarTitle>
            {test.models === 0
              ? 'No models installed yet — pull one with `ollama pull llama3.1`.'
              : `${String(test.models)} model${test.models === 1 ? '' : 's'} available.`}
          </MessageBarBody>
        </MessageBar>
      )}
      {test.status === 'failed' && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>{test.title}</MessageBarTitle>
            {test.body}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}
