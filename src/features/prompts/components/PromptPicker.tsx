/**
 * Header prompt-template selector (ARCHITECTURE.md §10, ROADMAP Phase 8).
 * Lists the free-form default, the 12 built-ins grouped by category, then the
 * user's customs under "My prompts". Two editor entry points, both owned
 * here: the "New prompt…" action row (intercepted — it opens the editor and
 * never changes the selection) and a pencil button that appears only while a
 * custom prompt is selected. App.tsx stays untouched: the row layout wraps
 * the Dropdown and the conditional button in one component.
 */
import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Button,
  Dropdown,
  Option,
  OptionGroup,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, EditRegular } from '@fluentui/react-icons';
import type { PromptTemplate } from '../../../types/domain';
import { BUILTIN_PROMPTS, CATEGORY_LABELS, CATEGORY_ORDER } from '../builtins';
import { usePromptsStore } from '../prompts.store';
import { findPrompt } from '../useSelectedPrompt';
import { PromptEditorDialog } from './PromptEditorDialog';

/** Sentinel option values — the store models "free prompt" as null. */
const FREE_PROMPT = '__free__';
const NEW_PROMPT = '__new__';

type EditorState = { open: false } | { open: true; promptId: string | null };

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  dropdown: { minWidth: 0, flexGrow: 1 },
});

export function PromptPicker(): ReactElement {
  const styles = useStyles();
  const customPrompts = usePromptsStore((state) => state.customPrompts);
  const selectedId = usePromptsStore((state) => state.selectedPromptId);
  const setSelectedPrompt = usePromptsStore((state) => state.setSelectedPrompt);
  const [editor, setEditor] = useState<EditorState>({ open: false });

  const selected = findPrompt(selectedId, customPrompts);
  const value = selected?.name ?? 'Free prompt';

  const builtinGroups = useMemo(
    () =>
      CATEGORY_ORDER.map((category) => ({
        category,
        label: CATEGORY_LABELS[category],
        prompts: BUILTIN_PROMPTS.filter((prompt) => prompt.category === category),
      })).filter((group) => group.prompts.length > 0),
    [],
  );

  const renderOption = (prompt: PromptTemplate): ReactElement => (
    <Option key={prompt.id} value={prompt.id} text={prompt.name}>
      {prompt.name}
    </Option>
  );

  return (
    <div className={styles.root}>
      <Dropdown
        className={styles.dropdown}
        aria-label="Prompt template"
        value={value}
        selectedOptions={[selected?.id ?? FREE_PROMPT]}
        onOptionSelect={(_, data) => {
          if (data.optionValue === NEW_PROMPT) {
            setEditor({ open: true, promptId: null });
            return; // action row, not a selection — the current template stays
          }
          setSelectedPrompt(data.optionValue === FREE_PROMPT ? null : (data.optionValue ?? null));
        }}
      >
        <Option value={FREE_PROMPT} text="Free prompt">
          Free prompt
        </Option>
        {builtinGroups.map((group) => (
          <OptionGroup key={group.category} label={group.label}>
            {group.prompts.map(renderOption)}
          </OptionGroup>
        ))}
        {customPrompts.length > 0 && (
          <OptionGroup label="My prompts">{customPrompts.map(renderOption)}</OptionGroup>
        )}
        <Option value={NEW_PROMPT} text="New prompt…">
          <AddRegular /> New prompt…
        </Option>
      </Dropdown>
      {selected !== null && !selected.builtIn && (
        <Button
          appearance="subtle"
          size="small"
          icon={<EditRegular />}
          aria-label={`Edit prompt ${selected.name}`}
          onClick={() => {
            setEditor({ open: true, promptId: selected.id });
          }}
        />
      )}
      <PromptEditorDialog
        open={editor.open}
        promptId={editor.open ? editor.promptId : null}
        onDismiss={() => {
          setEditor({ open: false });
        }}
      />
    </div>
  );
}
