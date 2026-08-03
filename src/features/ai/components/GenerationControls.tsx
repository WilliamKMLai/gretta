/**
 * Generate / Stop / Clear (ARCHITECTURE.md §10), enable/disable driven by the
 * §9 machine: Generate only from idle/terminal states, Stop only while
 * active, Clear only when a terminal state has something to clear.
 */
import type { ReactElement } from 'react';
import { Button, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import { DismissRegular, SendRegular, StopRegular } from '@fluentui/react-icons';
import { useStreamStore } from '../stream.store';

const useStyles = makeStyles({
  root: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
});

export interface GenerationControlsProps {
  onGenerate: () => void;
  /**
   * Phase 7: Stop must abort the in-flight request (useGeneration.stop), not
   * just flip the machine — falling back to the store's `cancel` keeps the
   * component usable standalone.
   */
  onStop?: (() => void) | undefined;
  /** Extra veto beyond machine state (no model picked, empty prompt, …). */
  generateDisabledReason?: string | undefined;
}

export function GenerationControls({
  onGenerate,
  onStop,
  generateDisabledReason,
}: GenerationControlsProps): ReactElement {
  const styles = useStyles();
  const status = useStreamStore((state) => state.status);
  const hasOutput = useStreamStore((state) => state.text !== '' || state.error !== null);
  const cancel = useStreamStore((state) => state.cancel);
  const reset = useStreamStore((state) => state.reset);

  const active = status === 'connecting' || status === 'streaming';
  const generateBlocked = active || generateDisabledReason !== undefined;

  const generateButton = (
    <Button
      appearance="primary"
      icon={<SendRegular />}
      disabled={generateBlocked}
      onClick={onGenerate}
    >
      Generate
    </Button>
  );

  return (
    <div className={styles.root} role="toolbar" aria-label="Generation">
      {generateDisabledReason !== undefined && !active ? (
        <Tooltip content={generateDisabledReason} relationship="description">
          {generateButton}
        </Tooltip>
      ) : (
        generateButton
      )}
      <Button icon={<StopRegular />} disabled={!active} onClick={onStop ?? cancel}>
        Stop
      </Button>
      <Button
        appearance="subtle"
        icon={<DismissRegular />}
        disabled={active || !hasOutput}
        onClick={reset}
      >
        Clear
      </Button>
    </div>
  );
}
