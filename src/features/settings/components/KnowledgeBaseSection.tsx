/**
 * Knowledge base settings.
 *
 * Split out of ConnectionSection as part of grouping settings by feature. The
 * embedding model lives here rather than with the other model pickers because
 * this is where people look for it — it was originally filed under Connection,
 * as a property of the server, which is technically true and practically
 * useless when someone is trying to get their documents indexed.
 *
 * It does serve literature ranking as well, and the hint says so, so a user
 * changing it here is not surprised later.
 */
import type { ReactElement } from 'react';
import { Field, Select, Subtitle2, Switch, makeStyles, tokens } from '@fluentui/react-components';
import { useModels } from '../../../hooks/useOllamaQueries';
import type { UseSettingsFormResult } from '../useSettingsForm';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
});

export function KnowledgeBaseSection({ form, setAndCommit }: UseSettingsFormResult): ReactElement {
  const styles = useStyles();
  const { watch } = form;
  const models = useModels();
  const installed = models.data ?? [];
  const embeddingModel = watch('defaultEmbeddingModel');
  const kbEnabled = watch('kbEnabled');
  const missingEmbedSelection =
    embeddingModel !== '' &&
    !models.isLoading &&
    !installed.some((model) => model.name === embeddingModel);

  return (
    <div className={styles.section}>
      <Subtitle2>Knowledge base</Subtitle2>
      <Field
        label="Knowledge base"
        hint="Lets GRETTA draw on your own documents. Off by default; needs the local companion running (`pnpm kb`)."
      >
        <Switch
          checked={watch('kbEnabled')}
          label={watch('kbEnabled') ? 'On' : 'Off'}
          onChange={(_, data) => {
            setAndCommit('kbEnabled', data.checked);
          }}
        />
      </Field>

      {/*
       * Detail stays hidden until the feature is on, matching literature
       * search. An embedding model picker is meaningless — and faintly
       * alarming — to someone who has not switched the knowledge base on, and
       * a settings panel that shows every control at once is how this one got
       * long enough to need reorganising in the first place.
       */}
      {!kbEnabled ? null : (
        <>
          <Field
            label="Embedding model"
            hint={
              missingEmbedSelection
                ? `${embeddingModel} is not installed on this server — pull it or pick another.`
                : 'Used by the knowledge base and by literature ranking. Must be an embedding model (e.g. nomic-embed-text, mxbai-embed-large), not a chat model. Changing it here does not touch existing collections.'
            }
          >
            <Select
              value={embeddingModel}
              disabled={models.isLoading}
              onChange={(_, data) => {
                setAndCommit('defaultEmbeddingModel', data.value);
              }}
            >
              {missingEmbedSelection && (
                <option value={embeddingModel}>{embeddingModel} (not installed)</option>
              )}
              {installed.map((model) => (
                <option key={model.name} value={model.name}>
                  {model.name}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}
    </div>
  );
}
