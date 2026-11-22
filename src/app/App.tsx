/**
 * Application shell (ARCHITECTURE.md §10): brand row with History/Settings
 * toggles, a picker row while chatting, and the active view. The scroll
 * contract from Phase 4's shell fix carries over — html/body/#root are
 * height:100%/overflow:hidden (global.css), <main> passes minHeight:0 down,
 * and each view owns its scroll region. The FluentProvider itself is
 * deliberately style-free (ADR-014): Fluent copies the provider's className
 * onto portal mount wrappers, so all visual styling lives on the inner
 * #gretta-app root div, sized 100vh because the provider is auto-height.
 */
import type { ReactElement } from 'react';
import {
  Button,
  FluentProvider,
  ToggleButton,
  Tooltip,
  mergeClasses,
  Toaster,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  AddRegular,
  HistoryRegular,
  BookSearchRegular,
  LibraryRegular,
  SettingsRegular,
} from '@fluentui/react-icons';
import { QueryClientProvider } from '@tanstack/react-query';
import { APP_TOASTER_ID } from '../components/toaster';
import {
  ModelPicker,
  abortActiveGeneration,
  useAttachmentsStore,
  useStreamStore,
} from '../features/ai';
import { useHistoryStore } from '../features/history';
import { PromptPicker } from '../features/prompts';
import { useTheme } from '../features/settings';
import type { HostInfo } from '../services/office';
import { APP_SHELL_ID } from './bootDiagnostics';
import { queryClient } from './queryClient';
import { useUiStore } from './ui.store';
import type { AppView } from './ui.store';
import { ChatView } from './views/ChatView';
import { KnowledgeBaseView } from './views/KnowledgeBaseView';
import { LiteratureView } from './views/LiteratureView';
import { HistoryView } from './views/HistoryView';
import { SettingsView } from './views/SettingsView';

const useStyles = makeStyles({
  root: {
    // 100vh, not 100%: the FluentProvider above is intentionally unstyled and
    // auto-height (ADR-014 — portal wrappers inherit the provider className).
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  headerPersonalityClearance: {
    // Office's personality menu (the ⓘ) overlays the TOP-RIGHT of the pane's
    // web content on Mac and Office on the web (documented platform behavior);
    // reserve clearance so our rightmost control stays visible and clickable.
    paddingRight: '30px',
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  brandRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  /**
   * The knowledge-graph mark, at the size the ribbon uses. Rendered from the
   * same asset as the Office icons so the pane and the ribbon never drift.
   */
  brandMark: {
    width: '22px',
    height: '22px',
    display: 'block',
    flexShrink: 0,
  },
  /**
   * Wordmark. Letter-spacing and weight carry the styling rather than a colour,
   * so it stays legible across the light, dark, and Match-Word themes.
   */
  brandWord: {
    fontSize: '17px',
    fontWeight: 700,
    letterSpacing: '0.16em',
    lineHeight: 1.2,
    color: tokens.colorNeutralForeground1,
    userSelect: 'none',
  },
  spacer: { flexGrow: 1 },
  pickers: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  picker: { flexGrow: 1, flexBasis: '140px', minWidth: 0 },
  main: {
    flexGrow: 1,
    minHeight: 0, // load-bearing: hands scroll ownership to the views
    display: 'flex',
    flexDirection: 'column',
    padding: tokens.spacingHorizontalM,
  },
});

export interface AppProps {
  hostInfo: HostInfo;
}

export function App({ hostInfo }: AppProps): ReactElement {
  const styles = useStyles();
  const theme = useTheme();
  const view = useUiStore((state) => state.view);
  const setView = useUiStore((state) => state.setView);

  const toggle = (target: AppView): void => {
    setView(view === target ? 'chat' : target);
  };

  const personalityMenuClearance =
    hostInfo.available && (hostInfo.platform === 'Mac' || hostInfo.platform === 'OfficeOnline');

  return (
    <FluentProvider theme={theme}>
      <QueryClientProvider client={queryClient}>
        <div id={APP_SHELL_ID} className={styles.root}>
          <Toaster toasterId={APP_TOASTER_ID} />
          <header
            className={mergeClasses(
              styles.header,
              personalityMenuClearance && styles.headerPersonalityClearance,
            )}
          >
            <div className={styles.brandRow}>
              <img
                src="assets/gretta-icon-64.png"
                alt=""
                aria-hidden="true"
                className={styles.brandMark}
              />
              <span
                className={styles.brandWord}
                title="Generative Research Engine for Technical Text Authoring"
              >
                GRETTA
              </span>
              <div className={styles.spacer} />
              {/*
               * Starting fresh is a navigation action, not something buried in
               * whichever pane you happen to be in. It was tried inside the
               * saved-result banner and inside the history header; both put it
               * somewhere you had to already be, and the banner one overlapped
               * its own text.
               */}
              <Tooltip content="New prompt" relationship="label" withArrow>
                <Button
                  appearance="subtle"
                  icon={<AddRegular />}
                  aria-label="New prompt"
                  onClick={() => {
                    abortActiveGeneration();
                    useStreamStore.getState().reset();
                    useAttachmentsStore.getState().clear();
                    useHistoryStore.getState().setActiveRecord(null);
                    useUiStore.getState().setDraft('');
                    setView('chat');
                  }}
                />
              </Tooltip>
              <Tooltip content="Past generations" relationship="label" withArrow>
                <ToggleButton
                  appearance="subtle"
                  icon={<HistoryRegular />}
                  aria-label="History"
                  checked={view === 'history'}
                  onClick={() => {
                    toggle('history');
                  }}
                />
              </Tooltip>
              <Tooltip content="Knowledge base" relationship="label" withArrow>
                <ToggleButton
                  appearance="subtle"
                  icon={<LibraryRegular />}
                  aria-label="Knowledge base"
                  checked={view === 'knowledge-base'}
                  onClick={() => {
                    toggle('knowledge-base');
                  }}
                />
              </Tooltip>
              <Tooltip content="Find literature" relationship="label" withArrow>
                <ToggleButton
                  appearance="subtle"
                  icon={<BookSearchRegular />}
                  aria-label="Literature"
                  checked={view === 'literature'}
                  onClick={() => {
                    toggle('literature');
                  }}
                />
              </Tooltip>
              <Tooltip content="Settings" relationship="label" withArrow>
                <ToggleButton
                  appearance="subtle"
                  icon={<SettingsRegular />}
                  aria-label="Settings"
                  checked={view === 'settings'}
                  onClick={() => {
                    toggle('settings');
                  }}
                />
              </Tooltip>
            </div>
            {view === 'chat' ? (
              <div className={styles.pickers}>
                <div className={styles.picker}>
                  <ModelPicker />
                </div>
                <div className={styles.picker}>
                  <PromptPicker />
                </div>
              </div>
            ) : null}
          </header>
          <main className={styles.main}>
            {view === 'chat' ? (
              <ChatView hostInfo={hostInfo} />
            ) : view === 'history' ? (
              <HistoryView />
            ) : view === 'literature' ? (
              <LiteratureView />
            ) : view === 'knowledge-base' ? (
              <KnowledgeBaseView />
            ) : (
              <SettingsView hostInfo={hostInfo} />
            )}
          </main>
        </div>
      </QueryClientProvider>
    </FluentProvider>
  );
}
