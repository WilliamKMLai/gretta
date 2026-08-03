/**
 * Settings form (ARCHITECTURE.md §10; ROADMAP Phase 9). This component owns
 * the RHF instance (`useSettingsForm`) and hands it to each section; the
 * sections are split out purely to keep every file under the 300-line rule.
 *
 * Every control commits to the store the moment its own value is valid — see
 * ADR-016 for why there is no Save button.
 */
import type { ReactElement } from 'react';
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Button,
  Divider,
  Field,
  Radio,
  RadioGroup,
  Subtitle2,
  Switch,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowResetRegular } from '@fluentui/react-icons';
import { Kbd } from '../../../components/Kbd';
import { useAppToasts } from '../../../components/toaster';
import type { HostInfo } from '../../../services/office';
import { useSettingsStore } from '../settings.store';
import type { SettingsFormValues } from '../settings.schema';
import { useSettingsForm } from '../useSettingsForm';
import { ConnectionSection } from './ConnectionSection';
import { GenerationSection } from './GenerationSection';
import { KnowledgeBaseSection } from './KnowledgeBaseSection';
import { LiteratureSection } from './LiteratureSection';

const useStyles = makeStyles({
  group: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalL,
  },
  shortcuts: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalXS,
    alignItems: 'center',
  },
});

export interface SettingsPanelProps {
  platform: HostInfo['platform'];
}

export function SettingsPanel({ platform }: SettingsPanelProps): ReactElement {
  const styles = useStyles();
  const toasts = useAppToasts();
  const resetSettings = useSettingsStore((state) => state.resetSettings);
  const settingsForm = useSettingsForm();
  const { form, setAndCommit, resetForm } = settingsForm;
  const { watch } = form;

  return (
    <div className={styles.root}>
      {/*
       * Grouped by feature, because that is how people arrive here: they want
       * to change something about the knowledge base, or about literature
       * search, and they look for that name. The previous arrangement grew by
       * accretion — each phase appended its fields wherever there was room —
       * which left the embedding model filed under Connection because it is
       * technically a property of the server, and unfindable by anyone trying
       * to index their documents.
       */}
      <ConnectionSection {...settingsForm} platform={platform} />

      <Divider />

      {/*
       * Collapsed by default. Sampling parameters are set once and rarely
       * revisited, but they occupy more vertical space than anything else here
       * — which pushed the settings people actually reach for, like the
       * embedding model, below the fold.
       */}
      <Accordion collapsible>
        <AccordionItem value="generation">
          <AccordionHeader size="large">Generation</AccordionHeader>
          <AccordionPanel>
            <div className={styles.group}>
              <GenerationSection {...settingsForm} />
            </div>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>

      <Divider />

      <div className={styles.group}>
        <Subtitle2>Response handling</Subtitle2>
        <Switch
          label="Stream tokens live"
          checked={watch('streaming')}
          onChange={(_, data) => {
            setAndCommit('streaming', data.checked);
          }}
        />
        <Switch
          label="Copy result to clipboard automatically"
          checked={watch('autoCopy')}
          onChange={(_, data) => {
            setAndCommit('autoCopy', data.checked);
          }}
        />
        <Switch
          label="Insert result at cursor automatically"
          checked={watch('autoInsert')}
          onChange={(_, data) => {
            setAndCommit('autoInsert', data.checked);
          }}
        />
      </div>

      <Divider />

      <KnowledgeBaseSection {...settingsForm} />

      <Divider />

      <LiteratureSection {...settingsForm} />

      <Divider />

      <div className={styles.group}>
        <Subtitle2>Appearance</Subtitle2>
        <Field label="Theme">
          <RadioGroup
            value={watch('theme')}
            onChange={(_, data) => {
              setAndCommit('theme', data.value as SettingsFormValues['theme']);
            }}
          >
            <Radio value="light" label="Light" />
            <Radio value="dark" label="Dark" />
            <Radio value="system" label="Match system" />
            <Radio value="office" label="Match Word" />
          </RadioGroup>
        </Field>
      </div>

      <Divider />
      <Subtitle2>Keyboard shortcuts</Subtitle2>
      <div className={styles.shortcuts}>
        <span>
          <Kbd>⌘/Ctrl</Kbd> + <Kbd>Enter</Kbd>
        </span>
        <Text size={200}>Generate</Text>
        <span>
          <Kbd>Esc</Kbd>
        </span>
        <Text size={200}>Stop generating</Text>
        <span>
          <Kbd>⌘/Ctrl</Kbd> + <Kbd>Shift</Kbd> + <Kbd>C</Kbd>
        </span>
        <Text size={200}>Copy result</Text>
        <span>
          <Kbd>⌘/Ctrl</Kbd> + <Kbd>Shift</Kbd> + <Kbd>I</Kbd>
        </span>
        <Text size={200}>Insert result at cursor</Text>
      </div>

      <Divider />
      <Button
        appearance="secondary"
        icon={<ArrowResetRegular />}
        onClick={() => {
          resetSettings();
          resetForm();
          toasts.success('Settings reset to defaults');
        }}
      >
        Reset to defaults
      </Button>
    </div>
  );
}
