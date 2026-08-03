/**
 * The "context chip" (ARCHITECTURE.md §10): which part of the document feeds
 * the prompt. Options are constrained by the selected template's `requires`
 * (a proofreading template that needs the selection can't run on "None").
 */
import type { ReactElement } from 'react';
import {
  Menu,
  MenuButton,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@fluentui/react-components';
import { DocumentTextRegular } from '@fluentui/react-icons';
import type { ContextSource } from '../../../types/domain';

const LABELS: Record<ContextSource, string> = {
  none: 'None',
  selection: 'Selection',
  paragraph: 'Paragraph',
  document: 'Whole document',
};

export interface ContextSourcePickerProps {
  value: ContextSource;
  options: readonly ContextSource[];
  onChange: (source: ContextSource) => void;
}

export function ContextSourcePicker({
  value,
  options,
  onChange,
}: ContextSourcePickerProps): ReactElement {
  return (
    <Menu
      checkedValues={{ context: [value] }}
      onCheckedValueChange={(_, data) => {
        const next = data.checkedItems[0];
        if (next !== undefined) onChange(next as ContextSource);
      }}
    >
      <MenuTrigger disableButtonEnhancement>
        <MenuButton
          appearance="subtle"
          size="small"
          icon={<DocumentTextRegular />}
          aria-label={`Context: ${LABELS[value]}`}
        >
          Context: {LABELS[value]}
        </MenuButton>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {options.map((option) => (
            <MenuItemRadio key={option} name="context" value={option}>
              {LABELS[option]}
            </MenuItemRadio>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
