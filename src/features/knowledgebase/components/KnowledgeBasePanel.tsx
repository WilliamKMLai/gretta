/**
 * Knowledge-base panel (ADR-020).
 *
 * The panel deliberately separates two scopes that are easy to confuse:
 *
 *   "This document"              — which collections the OPEN document draws on.
 *                                  Stored inside the .docx, so it travels with
 *                                  the file and differs per document.
 *   "Collections on this computer" — the collections themselves, which are
 *                                  global: creating, re-indexing, or deleting
 *                                  one affects every document.
 *
 * The summary at the top always states, in words, what the open document will
 * actually do on the next generation, so the effect of the per-collection
 * "Use in this document" checkbox is never in doubt.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import {
  Body1Strong,
  Button,
  Caption1,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, ArrowSyncRegular } from '@fluentui/react-icons';
import { getServices } from '../../../app/services';
import { EmptyState } from '../../../components/EmptyState';
import { useKbCollections, useKbHealth } from '../../../hooks/useKbQueries';
import { useModels } from '../../../hooks/useOllamaQueries';
import { describeFolderProblem, filterEmbeddingModels } from '../embeddingModels';
import { useSettingsStore } from '../../settings';
import { useDocumentBinding } from '../useDocumentBinding';
import { CollectionCard } from './CollectionCard';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  dataDir: { color: tokens.colorNeutralForeground3, wordBreak: 'break-all' },
  addRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' },
  grow: { flexGrow: 1 },
  muted: { color: tokens.colorNeutralForeground3 },
});

/** Turns a collection name into a stable id, since the user only types a name. */
function toId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
}

export function KnowledgeBasePanel(): ReactElement {
  const styles = useStyles();
  const kbEnabled = useSettingsStore((state) => state.kbEnabled);
  const defaultModel = useSettingsStore((state) => state.defaultEmbeddingModel);
  const setSettings = useSettingsStore((state) => state.setSettings);
  const health = useKbHealth(kbEnabled);
  const collections = useKbCollections(kbEnabled);
  const ollamaModels = useModels();
  const { boundCollectionIds, bindingLoaded, toggleCollection } = useDocumentBinding();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = (): void => {
    void collections.refetch();
  };

  const installedModels = (ollamaModels.data ?? []).map((model) => model.name);
  // `/api/tags` does not report capabilities, so embedding models are matched by
  // name. The full list stays reachable because a hint list can only ever be
  // incomplete — a user with an unusual model must not be locked out.
  const embeddingModels = filterEmbeddingModels(installedModels);
  const folderProblem = describeFolderProblem(folder);

  const addCollection = async (): Promise<void> => {
    if (name.trim() === '' || folder.trim() === '') return;
    setBusy(true);
    try {
      await getServices().kb.upsertCollection({
        id: toId(name),
        name: name.trim(),
        folders: [folder.trim()],
        embeddingModel: defaultModel,
      });
      setName('');
      setFolder('');
      refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!kbEnabled) {
    return (
      <div className={styles.root}>
        <EmptyState
          icon="📚"
          title="Knowledge base is off"
          body="Turn it on to let GRETTA draw on your own PDFs and Word documents."
        />
        <Button
          appearance="primary"
          onClick={() => {
            setSettings({ kbEnabled: true });
          }}
        >
          Enable knowledge base
        </Button>
      </div>
    );
  }

  if (health.isError) {
    return (
      <div className={styles.root}>
        <EmptyState
          icon="🔌"
          title="Companion not running"
          body="Start it with `pnpm kb`, then check again. Generation keeps working without it."
        />
        <Button
          icon={<ArrowSyncRegular />}
          onClick={() => {
            void health.refetch();
            refresh();
          }}
        >
          Check again
        </Button>
      </div>
    );
  }

  const all = collections.data ?? [];
  const boundNames = all
    .filter((collection) => boundCollectionIds.includes(collection.id))
    .map((collection) => collection.name);
  /**
   * The binding lives in the .docx, so a document written on another computer
   * can name a collection this one has never heard of. Saying so is important:
   * otherwise retrieval just silently returns nothing and the pane claims the
   * document uses no knowledge base at all.
   */
  const missingBound = boundCollectionIds.filter(
    (id) => !all.some((collection) => collection.id === id),
  );

  const dataDir = health.data?.dataDir;

  return (
    <div className={styles.root}>
      <section className={styles.section}>
        <Body1Strong>This document</Body1Strong>
        <MessageBar intent={boundNames.length === 0 ? 'info' : 'success'}>
          <MessageBarBody>
            {boundNames.length === 0
              ? 'Not using any knowledge base. Responses will be written without excerpts from your files.'
              : `Using ${boundNames.join(', ')}. Relevant excerpts are added to each prompt and cited under the response.`}
          </MessageBarBody>
        </MessageBar>
        {dataDir === undefined ? null : (
          <Caption1 className={styles.dataDir}>
            Your index lives in {dataDir}, outside the project folder. Deleting and reinstalling
            GRETTA does not remove it; delete that folder to clear every collection.
          </Caption1>
        )}
        {missingBound.length === 0 ? null : (
          <MessageBar intent="warning">
            <MessageBarBody>
              This document also expects{' '}
              {missingBound.length === 1 ? 'a collection' : 'collections'} named “
              {missingBound.join('”, “')}”, which {missingBound.length === 1 ? 'is' : 'are'} not on
              this computer. Create {missingBound.length === 1 ? 'one' : 'them'} with the same name,
              pointed at this machine’s copy of the folder, and the document will use{' '}
              {missingBound.length === 1 ? 'it' : 'them'} again.
            </MessageBarBody>
          </MessageBar>
        )}
        <Text size={200} className={styles.muted}>
          This choice is saved inside the document, so it travels with the file and can differ from
          one document to the next. Collections are matched by name, so using the same name on
          another computer picks up where you left off.
        </Text>
      </section>

      <section className={styles.section}>
        <Body1Strong>Collections on this computer</Body1Strong>
        <Text size={200} className={styles.muted}>
          Shared by every document. Tick “Use in this document” on the ones this document should
          draw on.
        </Text>

        {collections.isLoading ? <Spinner size="tiny" label="Loading collections…" /> : null}
        {all.length === 0 && !collections.isLoading ? (
          <Text size={200} className={styles.muted}>
            No collections yet. Add a folder of PDFs, Word files, or notes below.
          </Text>
        ) : null}

        {all.map((collection) => (
          <CollectionCard
            key={collection.id}
            collection={collection}
            bound={boundCollectionIds.includes(collection.id)}
            bindingLoaded={bindingLoaded}
            models={embeddingModels}
            onToggleBound={(bound) => {
              void toggleCollection(collection.id, bound);
            }}
            onSave={(config) => {
              void getServices().kb.upsertCollection(config).then(refresh, refresh);
            }}
            onReindex={() => {
              void getServices().kb.reindexCollection(collection.id, false).then(refresh, refresh);
            }}
            onDelete={() => {
              void getServices().kb.deleteCollection(collection.id).then(refresh, refresh);
            }}
          />
        ))}
      </section>

      <section className={styles.section}>
        <Body1Strong>Add a collection</Body1Strong>
        <Text size={200} className={styles.muted}>
          Both fields are required.
        </Text>
        <Field
          label="Name"
          required
          validationState={name.trim() === '' ? 'warning' : 'none'}
          validationMessage={name.trim() === '' ? 'Give the collection a name.' : null}
        >
          <Input
            value={name}
            onChange={(_, data) => {
              setName(data.value);
            }}
            placeholder="Reference library"
          />
        </Field>
        <Field
          label="Folder"
          required
          hint="Word add-ins cannot open a folder picker, so paste the full path."
          validationState={folderProblem === null ? 'none' : 'warning'}
          validationMessage={folderProblem}
        >
          <Input
            value={folder}
            onChange={(_, data) => {
              setFolder(data.value);
            }}
            placeholder="/Users/you/Documents/References"
          />
        </Field>
        <div className={styles.addRow}>
          <Button
            appearance="primary"
            icon={<AddRegular />}
            disabled={busy || name.trim() === '' || folderProblem !== null}
            onClick={() => {
              void addCollection();
            }}
          >
            Add collection
          </Button>
        </div>
      </section>
    </div>
  );
}
