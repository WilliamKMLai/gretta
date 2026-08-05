/**
 * One collection in the knowledge-base panel (ADR-020).
 *
 * The card has to make a scope distinction the user cannot otherwise see: the
 * collection itself is global (it lives in the companion and is shared by every
 * document), while the checkbox only affects the document that is currently
 * open. So the control is labeled "Use in this document" rather than by the
 * collection name — a checkbox labeled with the name reads as "enable this
 * collection", which is a different and much bigger-sounding action.
 *
 * Editing keeps the collection **id** fixed even when the name changes, because
 * documents store ids in their binding: renaming must not orphan every document
 * that already points here. Changing the embedding model is called out as
 * re-indexing work, since vectors from different models are not comparable.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import {
  Body1Strong,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  ProgressBar,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowSyncRegular, DeleteRegular, EditRegular } from '@fluentui/react-icons';
import type { CollectionConfig, CollectionStatus } from '../../../types/knowledgebase';
import { formatRelativeTime } from '../../../utils/time';
import { describePhase } from '../knowledgebase.store';
import { CollectionEditor } from './CollectionEditor';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  cardBound: { border: `1px solid ${tokens.colorBrandStroke1}` },
  headerRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  grow: { flexGrow: 1, minWidth: 0 },
  stats: {
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalXXS,
    color: tokens.colorNeutralForeground3,
  },
  muted: { color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere' },
});

export interface CollectionCardProps {
  collection: CollectionStatus;
  /** True when the OPEN DOCUMENT is bound to this collection. */
  bound: boolean;
  /** Disabled until the document's binding has been read. */
  bindingLoaded: boolean;
  /** Installed Ollama models offered as embedding models. */
  models: string[];
  onToggleBound: (bound: boolean) => void;
  onReindex: () => void;
  onDelete: () => void;
  onSave: (config: CollectionConfig) => void;
}

export function CollectionCard({
  collection,
  bound,
  bindingLoaded,
  models,
  onToggleBound,
  onReindex,
  onDelete,
  onSave,
}: CollectionCardProps): ReactElement {
  const styles = useStyles();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const capacity = Math.min(collection.capacityPct, 100);

  return (
    <div className={bound ? `${styles.card} ${styles.cardBound}` : styles.card}>
      <div className={styles.headerRow}>
        <Body1Strong className={styles.grow}>{collection.name}</Body1Strong>
        {editing ? null : (
          <>
            <Tooltip content="Edit name, folders, or embedding model" relationship="label">
              <Button
                size="small"
                appearance="subtle"
                icon={<EditRegular />}
                aria-label={`Edit ${collection.name}`}
                onClick={() => {
                  setEditing(true);
                }}
              />
            </Tooltip>
            <Tooltip content="Check the folders for changes now" relationship="label">
              <Button
                size="small"
                appearance="subtle"
                icon={<ArrowSyncRegular />}
                aria-label={`Re-index ${collection.name}`}
                onClick={onReindex}
              />
            </Tooltip>
            <Tooltip content="Delete this collection from your computer" relationship="label">
              <Button
                size="small"
                appearance="subtle"
                icon={<DeleteRegular />}
                aria-label={`Delete ${collection.name}`}
                onClick={() => {
                  setConfirmingDelete(true);
                }}
              />
            </Tooltip>
          </>
        )}
      </div>

      {editing ? (
        <CollectionEditor
          collection={collection}
          models={models}
          onCancel={() => {
            setEditing(false);
          }}
          onSave={(config) => {
            setEditing(false);
            onSave(config);
          }}
        />
      ) : (
        <>
          <Checkbox
            checked={bound}
            disabled={!bindingLoaded}
            label="Use in this document"
            onChange={(_, data) => {
              onToggleBound(data.checked === true);
            }}
          />
          <Text size={200} className={styles.muted}>
            {collection.folders.join(', ')}
          </Text>
          <Text size={200} className={styles.muted}>
            {describePhase(collection)}
          </Text>
          <ProgressBar value={capacity / 100} aria-label={`${collection.name} capacity used`} />
          {collection.overCapacity ? (
            <MessageBar intent="warning">
              <MessageBarBody>
                This collection is past the size the fast index is tuned for — retrieval will be
                slower. Splitting it into two collections by topic will help.
              </MessageBarBody>
            </MessageBar>
          ) : null}
          <div className={styles.stats}>
            <Text size={200}>{collection.fileCount.toLocaleString()} files</Text>
            <Text size={200}>·</Text>
            <Text size={200}>{collection.chunkCount.toLocaleString()} excerpts</Text>
            <Text size={200}>·</Text>
            <Text size={200}>
              {collection.capacityPct}% of {collection.maxChunks.toLocaleString()}
            </Text>
            <Text size={200}>·</Text>
            <Text size={200}>{collection.embeddingModel}</Text>
            {collection.lastIndexedAt === null ? null : (
              <>
                <Text size={200}>·</Text>
                <Text size={200}>indexed {formatRelativeTime(collection.lastIndexedAt)}</Text>
              </>
            )}
          </div>
          {collection.skipped.length === 0 ? null : (
            <Text size={200} className={styles.muted}>
              Skipped {collection.skipped.length} file(s) — e.g. {collection.skipped[0]?.path}:{' '}
              {collection.skipped[0]?.reason}
            </Text>
          )}
        </>
      )}

      <Dialog
        open={confirmingDelete}
        onOpenChange={(_, data) => {
          setConfirmingDelete(data.open);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete “{collection.name}”?</DialogTitle>
            <DialogContent>
              <Text>
                This removes the collection and its {collection.chunkCount.toLocaleString()} indexed
                excerpts from this computer. Your files are not touched, and any document still
                bound to it simply stops retrieving. You can add it again later, but it will need to
                re-index.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => {
                  setConfirmingDelete(false);
                }}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={() => {
                  setConfirmingDelete(false);
                  onDelete();
                }}
              >
                Delete collection
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
