/**
 * "Choose folder…" — opens the companion's native OS dialog (ADR-033).
 *
 * Shared by the add-a-collection form and the per-collection editor, which are
 * the only two places a folder path is entered.
 *
 * Renders **nothing** when the companion is absent, too old to advertise the
 * capability, or running on a platform without a dialog (Linux, WSL). A visible
 * button that cannot open anything is worse than no button, and the text input
 * beside it has always been, and remains, a complete way to do this.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import { Button, Tooltip } from '@fluentui/react-components';
import { FolderOpenRegular } from '@fluentui/react-icons';
import { useKbHealth } from '../../../hooks/useKbQueries';
import { getServices } from '../../../app/services';

export interface FolderPickerButtonProps {
  /** Called with the chosen absolute path. Not called on cancel. */
  onPicked: (path: string) => void;
  disabled?: boolean;
}

export function FolderPickerButton({
  onPicked,
  disabled = false,
}: FolderPickerButtonProps): ReactElement | null {
  // Already in flight from the panel above; TanStack dedupes on the key, so
  // asking again here costs nothing and avoids threading a prop through
  // CollectionCard purely to reach the editor.
  const health = useKbHealth(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (health.data?.pickFolder !== true) return null;

  const choose = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await getServices().kb.pickFolder();
      if (result.ok) {
        onPicked(result.path);
        return;
      }
      // Dismissing a dialog is a normal thing to do, so it leaves the input
      // exactly as it was and says nothing (ADR-033). `busy` is the user's own
      // second click while a dialog is open — also not worth a message.
      if (result.reason === 'cancelled' || result.reason === 'busy') return;
      setProblem(result.message ?? 'The folder picker could not be opened.');
    } catch {
      // The companion went away between the health check and the click.
      setProblem('The knowledge-base companion is not reachable.');
    } finally {
      setBusy(false);
    }
  };

  const button = (
    <Button
      icon={<FolderOpenRegular />}
      disabled={disabled || busy}
      onClick={() => {
        void choose();
      }}
    >
      {busy ? 'Choosing…' : 'Choose folder…'}
    </Button>
  );

  return problem === null ? (
    button
  ) : (
    <Tooltip content={problem} relationship="description">
      {button}
    </Tooltip>
  );
}
