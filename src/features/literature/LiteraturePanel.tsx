/**
 * The literature search surface (DECISIONS.md ADR-028, ADR-029; ADR-027 for
 * the short pane).
 *
 * The layout is arranged around the review gate. The field showing the query
 * is not a convenience — it is the mechanism by which "only a query you have
 * seen and approved" is true, so it shows the exact string that will be sent,
 * it is editable, and the Search button is a separate deliberate action. The
 * privacy line sits directly above it in the same words as the README and the
 * settings panel, because a user must not meet a stronger version of the
 * promise than the one that holds.
 */
import { useCallback } from 'react';
import type { ReactElement } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Field,
  MessageBar,
  MessageBarBody,
  Spinner,
  Textarea,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular, SearchRegular, TextGrammarWandRegular } from '@fluentui/react-icons';
import { MAX_QUERY_CHARS } from '../../services/literature';
import { EmptyState } from '../../components/EmptyState';
import { useSettingsStore } from '../settings';
import { useLiteratureStore } from './literature.store';
import { useLiteratureSearch } from './useLiteratureSearch';
import { LiteratureAdvancedParams } from './LiteratureAdvancedParams';
import { LiteratureHistoryList } from './LiteratureHistoryList';
import { LiteratureResultList } from './LiteratureResultList';

const useStyles = makeStyles({
  /*
   * The whole panel scrolls, not an inner region. The previous arrangement gave
   * the results list `flex: 1; overflow: auto` inside a non-scrolling column,
   * which meant everything above it — the promise, the warning bar, the query
   * field — competed for a fixed height and overlapped once any of them wrapped
   * to a second line. A pane that can be dragged to a few hundred pixels
   * (ADR-027) has no fixed height to divide up.
   */
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    height: '100%',
    overflowY: 'auto',
    paddingRight: tokens.spacingHorizontalXS,
  },
  /*
   * Every direct child of a scrolling flex column needs this.
   *
   * `flex-shrink` defaults to 1, so once the content is taller than the pane
   * the browser compresses *all* the children rather than letting the container
   * scroll — buttons lose their padding, message bars clip their own second
   * line, and text overlaps whatever is beneath it. It looks like a rendering
   * fault and is actually the default behaviour of a column that has run out of
   * room. Pinning each child to its natural height is what makes the overflow
   * reach the scroll container instead.
   */
  fixed: { flexShrink: 0 },
  /*
   * The off state is a plain column, matching the knowledge base exactly. The
   * search layout needs `height: 100%` and a scroll container; an empty state
   * with a single button does not, and inheriting them stretched the panel and
   * placed the button differently from the sibling feature it should look like.
   */
  offRoot: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    // Pinned for the same reason as the search layout: the view wrapper is a
    // flex column, so an unpinned button loses its padding and renders shorter
    // than the identical one on the knowledge base pane.
    '> *': { flexShrink: 0 },
  },
  promise: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  spacer: { flex: 1 },
  // Flows with the panel; the panel scrolls.
  results: { flexShrink: 0 },
  // Scrolls rather than clipping: a selected passage is often several
  // sentences, and a pane that shows two and a half of them with no way to
  // reach the rest reads as a rendering fault.
  passage: {
    color: tokens.colorNeutralForeground3,
    borderLeft: `2px solid ${tokens.colorNeutralStroke2}`,
    paddingLeft: tokens.spacingHorizontalS,
    maxHeight: '6em',
    overflowY: 'auto',
    whiteSpace: 'pre-wrap',
  },
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
  },
});

export function LiteraturePanel(): ReactElement {
  const styles = useStyles();
  const { phase, passage, draft, error, results, setDraft } = useLiteratureStore();
  const { captureAndDraft, search, cancel, busy } = useLiteratureSearch();
  const litEnabled = useSettingsStore((state) => state.litEnabled);
  const sources = useSettingsStore((state) => state.litSources);
  const litVerification = useSettingsStore((state) => state.litVerification);
  const setSettings = useSettingsStore((state) => state.setSettings);

  const anySource = Object.values(sources).some(Boolean);
  const tooLong = draft.length > MAX_QUERY_CHARS;
  const searchingStatus = litVerification
    ? 'Searching, checking retractions, and ranking against your selection…'
    : 'Searching and ranking against your selection…';

  const onDraftChange = useCallback(
    (_event: unknown, data: { value: string }) => {
      setDraft(data.value);
    },
    [setDraft],
  );

  if (!litEnabled) {
    // Matches the knowledge base: a feature that is off should be switchable on
    // from the place you went looking for it, not only from Settings.
    return (
      <div className={styles.offRoot}>
        <EmptyState
          icon="🔍"
          title="Literature search is off"
          body="Turn it on to search PubMed, bioRxiv, medRxiv, and OpenAlex from a passage in your document."
        />
        <Button
          appearance="primary"
          onClick={() => {
            setSettings({ litEnabled: true });
          }}
        >
          Enable literature search
        </Button>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <Caption1 className={mergeClasses(styles.promise, styles.fixed)}>
        Literature search reaches third-party scholarly APIs. It sends only a search query you have
        seen and approved — never your document, your excerpts, or your prompts.
      </Caption1>
      <LiteratureHistoryList />

      {!anySource ? (
        <MessageBar className={styles.fixed} intent="warning" layout="multiline">
          <MessageBarBody>
            No sources are turned on. Turn on at least one below before searching.
          </MessageBarBody>
        </MessageBar>
      ) : null}

      <Button
        className={styles.fixed}
        icon={phase === 'drafting' ? <Spinner size="tiny" /> : <TextGrammarWandRegular />}
        onClick={() => {
          void captureAndDraft();
        }}
        disabled={busy}
      >
        {phase === 'drafting' ? 'Reading your selection…' : 'Draft a query from my selection'}
      </Button>

      {phase === 'drafting' ? (
        <Caption1 className={styles.status}>
          Writing a query from the passage, on your machine. Nothing has been sent.
        </Caption1>
      ) : null}

      {passage === '' ? null : (
        <Caption1 className={styles.passage} title={passage}>
          {passage}
        </Caption1>
      )}

      <Field
        className={styles.fixed}
        label="Search query"
        hint={
          tooLong
            ? `${String(draft.length)} characters — shorten to ${String(MAX_QUERY_CHARS)} or fewer.`
            : 'This exact text is what will be sent. Edit it freely.'
        }
        validationState={tooLong ? 'error' : 'none'}
      >
        <Textarea value={draft} onChange={onDraftChange} resize="vertical" rows={2} />
      </Field>

      <LiteratureAdvancedParams />

      <div className={mergeClasses(styles.actions, styles.fixed)}>
        <Button
          appearance="primary"
          icon={busy ? <Spinner size="tiny" /> : <SearchRegular />}
          onClick={() => {
            void search();
          }}
          disabled={busy || draft.trim() === '' || tooLong || !anySource}
        >
          {phase === 'searching' ? 'Searching…' : 'Search'}
        </Button>
        {/*
         * Rendered only while something is in flight, rather than always
         * present and disabled: the drafting button above it is the one the
         * user reaches for repeatedly, and a permanently greyed Cancel beside
         * Search reads as a control that is broken rather than one that has
         * nothing to stop. It covers drafting as well as searching — both are
         * long enough to want out of.
         */}
        {busy ? (
          <Button icon={<DismissRegular />} onClick={cancel}>
            Cancel
          </Button>
        ) : null}
        <div className={styles.spacer} />
      </div>

      {error === null ? null : (
        <MessageBar className={styles.fixed} intent="error" layout="multiline">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.results}>
        {phase === 'searching' ? (
          <div className={styles.status}>
            <Spinner size="tiny" />
            <Caption1>{searchingStatus}</Caption1>
          </div>
        ) : phase === 'done' && results.length === 0 ? (
          <Body1>No results. Try broader keywords, or turn on another source.</Body1>
        ) : (
          <LiteratureResultList />
        )}
      </div>
    </div>
  );
}
