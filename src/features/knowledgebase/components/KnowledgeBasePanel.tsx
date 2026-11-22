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
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Body1Strong,
  Button,
  Caption1,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Switch,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, ArrowSyncRegular } from '@fluentui/react-icons';
import { getServices } from '../../../app/services';
import { EmptyState } from '../../../components/EmptyState';
import { useAppToasts } from '../../../components/toaster';
import { useKbCollections, useKbHealth } from '../../../hooks/useKbQueries';
import { useModels } from '../../../hooks/useOllamaQueries';
import { newId } from '../../../utils/id';
import { describeFolderProblem, filterEmbeddingModels } from '../embeddingModels';
import { useSettingsStore } from '../../settings';
import { useDocumentBinding } from '../useDocumentBinding';
import { CollectionCard } from './CollectionCard';
import { FolderPickerButton } from './FolderPickerButton';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  dataDir: { color: tokens.colorNeutralForeground3, wordBreak: 'break-all' },
  addRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' },
  /** The form's fields, indented under the disclosure so they read as its contents. */
  addForm: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  muted: { color: tokens.colorNeutralForeground3 },
});

/** Turns a collection name into a stable id, falling back to a unique id for non-Latin names. */
function toId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
  return slug === '' ? newId() : slug;
}

function describeFailure(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback;
}

export function KnowledgeBasePanel(): ReactElement {
  const styles = useStyles();
  const toasts = useAppToasts();
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
  /*
   * Set at creation, not afterwards (ADR-036 amendment).
   *
   * Turning figures on later forces a full rebuild — figure captions are their
   * own chunks, so the chunk set genuinely changes. Deciding here means the
   * first index is the right one and that cost is never paid at all.
   */
  const [indexFigures, setIndexFigures] = useState(false);
  /**
   * Null until the user touches the disclosure; the default is derived below.
   *
   * Controlled rather than `defaultOpenItems`, because that is read once at
   * mount — when the collections query is still in flight and the list is
   * therefore empty. The form would have opened every single time, which is
   * exactly the behaviour this was meant to remove.
   */
  const [addOpen, setAddOpen] = useState<boolean | null>(null);

  const refresh = (): void => {
    void collections.refetch();
  };

  const installedModels = (ollamaModels.data ?? []).map((model) => model.name);
  // `/api/tags` does not report capabilities, so embedding models are matched by
  // name. The full list stays reachable because a hint list can only ever be
  // incomplete — a user with an unusual model must not be locked out.
  const embeddingModels = filterEmbeddingModels(installedModels);
  const folderProblem = describeFolderProblem(folder);
  /*
   * Closed until the collections query answers, so a form that is about to
   * close does not flash open first. Once the answer is in, an empty knowledge
   * base opens it — adding a collection is then the only thing to do.
   */
  const addFormOpen = addOpen ?? (collections.isSuccess && collections.data.length === 0);

  const addCollection = async (): Promise<void> => {
    if (name.trim() === '' || folder.trim() === '') return;
    setBusy(true);
    try {
      await getServices().kb.upsertCollection({
        id: toId(name),
        name: name.trim(),
        folders: [folder.trim()],
        embeddingModel: defaultModel,
        indexFigures,
      });
      setName('');
      setFolder('');
      setIndexFigures(false);
      refresh();
    } catch (error) {
      toasts.error(describeFailure(error, 'Could not add the collection.'));
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
            onSave={async (config) => {
              try {
                await getServices().kb.upsertCollection(config);
                refresh();
                return true;
              } catch (error) {
                toasts.error(describeFailure(error, 'Could not save collection changes.'));
                refresh();
                return false;
              }
            }}
            onReindex={() => {
              void getServices()
                .kb.reindexCollection(collection.id, false)
                .then(refresh, (error: unknown) => {
                  toasts.error(describeFailure(error, 'Could not start re-indexing.'));
                  refresh();
                });
            }}
            onDelete={() => {
              void getServices()
                .kb.deleteCollection(collection.id)
                .then(refresh, (error: unknown) => {
                  toasts.error(describeFailure(error, 'Could not delete the collection.'));
                  refresh();
                });
            }}
          />
        ))}
      </section>

      {/*
        Collapsed once collections exist, expanded when there are none.
        Everything in this panel was previously the same weight, so the fields
        below — the figures switch especially — did not read as belonging to
        the add form at all. A disclosure gives them one container and one
        heading, and reclaims the space they occupied on every visit.

        Open on an empty knowledge base because adding a collection is then the
        only thing to do, and hiding the sole available action behind a click
        is the opposite of decluttering (the same reasoning as the literature
        panel's "Recent searches").
      */}
      <Accordion
        collapsible
        openItems={addFormOpen ? ['add-collection'] : []}
        onToggle={(_, data) => {
          setAddOpen(data.openItems.includes('add-collection'));
        }}
      >
        <AccordionItem value="add-collection">
          <AccordionHeader size="small">
            <Body1Strong>Add a collection</Body1Strong>
          </AccordionHeader>
          <AccordionPanel>
            <div className={styles.addForm}>
              <Text size={200} className={styles.muted}>
                Name and folder are required.
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
                hint="Choose one below, or paste the full path — the pane itself cannot open a picker, so the button asks the companion to."
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
              {health.data?.describeFigures === true ? (
                <Field
                  label="Index figures"
                  hint="Find figures in PDFs so GRETTA can search them and look at them when answering. Costs almost nothing while indexing; each figure is rendered the first time it comes up. Needs a vision model. Changing this later rebuilds the collection."
                >
                  <Switch
                    checked={indexFigures}
                    label={indexFigures ? 'On' : 'Off'}
                    disabled={busy}
                    onChange={(_, data) => {
                      setIndexFigures(data.checked);
                    }}
                  />
                </Field>
              ) : null}
              <div className={styles.addRow}>
                <FolderPickerButton onPicked={setFolder} disabled={busy} />
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
            </div>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
