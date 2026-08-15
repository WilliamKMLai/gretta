/**
 * Inline editor for one collection (ADR-020).
 *
 * The collection **id** is never edited: documents bind by id, so renaming a
 * collection must not orphan every document already pointing at it. Changing
 * the embedding model is surfaced as re-indexing work, because vectors produced
 * by different models are not comparable and the companion rebuilds on change.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import {
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Select,
  Switch,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CheckmarkRegular, DismissRegular } from '@fluentui/react-icons';
import type { CollectionConfig, CollectionStatus } from '../../../types/knowledgebase';
import { FolderPickerButton } from './FolderPickerButton';
import { useKbHealth } from '../../../hooks/useKbQueries';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, justifyContent: 'flex-end' },
  pick: { display: 'flex' },
});

export interface CollectionEditorProps {
  collection: CollectionStatus;
  /** Installed Ollama models offered as embedding models. */
  models: string[];
  onCancel: () => void;
  onSave: (config: CollectionConfig) => void;
}

export function CollectionEditor({
  collection,
  models,
  onCancel,
  onSave,
}: CollectionEditorProps): ReactElement {
  const styles = useStyles();
  const [name, setName] = useState(collection.name);
  const [folders, setFolders] = useState(collection.folders.join('\n'));
  const [model, setModel] = useState(collection.embeddingModel);
  const [indexFigures, setIndexFigures] = useState(collection.indexFigures);
  // Offered only when the companion can actually render figures (ADR-036),
  // the same capability gate FolderPickerButton uses.
  const canDescribe = useKbHealth(true).data?.describeFigures === true;

  const parsedFolders = folders
    .split('\n')
    .map((folder) => folder.trim())
    .filter((folder) => folder !== '');
  const valid = name.trim() !== '' && parsedFolders.length > 0;
  const modelChanged = model !== collection.embeddingModel;
  const figuresChanged = indexFigures !== collection.indexFigures;

  return (
    <div className={styles.form}>
      <Field label="Name" required>
        <Input
          value={name}
          onChange={(_, data) => {
            setName(data.value);
          }}
        />
      </Field>
      <Field label="Folders" required hint="One absolute path per line.">
        <Textarea
          value={folders}
          rows={2}
          onChange={(_, data) => {
            setFolders(data.value);
          }}
        />
      </Field>
      {/*
       * Appends rather than replaces: this field is a list, and a collection
       * spanning two folders is ordinary. The textarea stays editable — a
       * network volume may not be reachable from the dialog, and the picker is
       * absent on Linux entirely (ADR-033).
       */}
      <div className={styles.pick}>
        <FolderPickerButton
          onPicked={(path) => {
            setFolders((current) => {
              const lines = current.split('\n').map((line) => line.trim());
              return lines.includes(path)
                ? current
                : [...lines.filter((line) => line !== ''), path].join('\n');
            });
          }}
        />
      </div>
      <Field label="Embedding model">
        <Select
          value={model}
          onChange={(_, data) => {
            setModel(data.value);
          }}
        >
          {!models.includes(model) && <option value={model}>{model} (not installed)</option>}
          {models.map((installed) => (
            <option key={installed} value={installed}>
              {installed}
            </option>
          ))}
        </Select>
      </Field>
      {modelChanged ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            Changing the embedding model re-indexes this collection from scratch — excerpts made by
            a different model are not comparable.
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {figuresChanged ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            Changing this re-indexes the collection from scratch — figure captions are stored as
            their own excerpts, so turning it on or off changes which excerpts exist.
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {canDescribe ? (
        <Field
          label="Index figures"
          hint={
            indexFigures
              ? 'Figures in PDFs are found by their captions and can be looked at when answering. Each one is rendered and described the first time it comes up.'
              : 'Find figures in PDFs so GRETTA can search them and look at them when answering. Needs a vision model.'
          }
        >
          <Switch
            checked={indexFigures}
            label={indexFigures ? 'On' : 'Off'}
            onChange={(_, data) => {
              setIndexFigures(data.checked);
            }}
          />
        </Field>
      ) : null}

      <div className={styles.actions}>
        <Button size="small" icon={<DismissRegular />} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="small"
          appearance="primary"
          icon={<CheckmarkRegular />}
          disabled={!valid}
          onClick={() => {
            // id preserved on purpose — documents bind by id (ADR-020).
            onSave({
              id: collection.id,
              name: name.trim(),
              folders: parsedFolders,
              embeddingModel: model,
              indexFigures,
            });
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
