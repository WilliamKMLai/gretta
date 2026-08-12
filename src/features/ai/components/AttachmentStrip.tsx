/**
 * Staged images, and the truth about whether they will be sent (ADR-034).
 *
 * Renders nothing when nothing is attached, so the prompt area is unchanged for
 * everyone not using this.
 *
 * The capability warning lives here rather than in Settings on purpose. A
 * settings-panel warning is read by people already in Settings; this one
 * appears at the moment the user does the thing that will not work, which is
 * the only moment they are motivated to fix it. It states the model, what it
 * cannot do, and where to change it — a warning without the fix is just an
 * apology.
 */
import type { ReactElement } from 'react';
import {
  Button,
  Caption1,
  MessageBar,
  MessageBarBody,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import { useAttachmentsStore } from '../attachments.store';
import { useVisionModel } from '../useVisionModel';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  strip: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  chip: {
    position: 'relative',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    overflow: 'hidden',
    lineHeight: 0,
  },
  thumb: { width: '3.5rem', height: '3.5rem', objectFit: 'cover', display: 'block' },
  remove: { position: 'absolute', top: 0, right: 0, minWidth: 'auto', padding: '2px' },
  dimmed: { opacity: 0.5 },
});

export function AttachmentStrip(): ReactElement | null {
  const styles = useStyles();
  const images = useAttachmentsStore((state) => state.images);
  const remove = useAttachmentsStore((state) => state.remove);
  const vision = useVisionModel();

  if (images.length === 0) return null;

  const blocked = vision.reason !== null;

  return (
    <div className={styles.root}>
      <div className={styles.strip}>
        {images.map((image) => (
          <div key={image.id} className={blocked ? styles.dimmed : undefined}>
            <Tooltip content={image.name} relationship="label">
              <div className={styles.chip}>
                <img
                  className={styles.thumb}
                  src={`data:image/png;base64,${image.dataBase64}`}
                  alt={image.name}
                />
                <Button
                  className={styles.remove}
                  appearance="subtle"
                  size="small"
                  icon={<DismissRegular />}
                  aria-label={`Remove ${image.name}`}
                  onClick={() => {
                    remove(image.id);
                  }}
                />
              </div>
            </Tooltip>
          </div>
        ))}
      </div>

      {blocked ? (
        <MessageBar intent="warning">
          <MessageBarBody>{vision.reason}</MessageBarBody>
        </MessageBar>
      ) : vision.isSeparateModel ? (
        // Not a problem, but not free either: Ollama unloads the general model
        // and loads this one, so the first image run after a text run is slow
        // for a reason the user would otherwise have no way to explain.
        <Caption1>Answered by {vision.model} — switching models may take a moment.</Caption1>
      ) : null}
    </div>
  );
}
