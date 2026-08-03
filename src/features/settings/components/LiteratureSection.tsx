/**
 * Literature settings (DECISIONS.md ADR-028).
 *
 * These toggles are the security control, not the CSP — the CSP is static and
 * cannot express a per-source switch, so it bounds the blast radius to a known
 * host list while these decide what is actually contacted. Everything ships
 * off.
 *
 * The privacy consequence is stated *here*, at the point of enabling, in the
 * same words as the README and the search surface. ADR-028 requires the same
 * wording in all three places, because a user must never meet a stronger
 * version of the promise than the one that holds. OpenAlex gets its own
 * sentence: it receives the identifiers of results being ranked, so it learns
 * what is being read rather than only what was searched for, and that is a
 * different disclosure.
 */
import type { ReactElement } from 'react';
import {
  Subtitle2,
  Caption1,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Select,
  Switch,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useModels } from '../../../hooks/useOllamaQueries';
import type { UseSettingsFormResult } from '../useSettingsForm';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  sources: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM,
  },
  note: { color: tokens.colorNeutralForeground3 },
});

interface SourceRow {
  key: 'pubmed' | 'biorxiv' | 'medrxiv' | 'openalex';
  label: string;
  hint: string;
}

/**
 * Every source here is implemented and reachable from the task pane. arXiv was
 * removed rather than shown disabled: it sends no CORS header, so a browser can
 * never read its response, and neither can DataCite, which is the only other
 * route to arXiv metadata. `pnpm smoke:lit` still measures both, so the
 * decision has standing evidence and would reverse itself if either changed.
 */
const SOURCES = [
  {
    key: 'pubmed',
    label: 'PubMed',
    hint: 'Primary source. Free, no account needed, and the best abstract coverage of any source. Strongest in biomedicine, weaker outside it.',
  },
  {
    key: 'biorxiv',
    label: 'bioRxiv',
    hint: 'Biology preprints. bioRxiv publishes no keyword search API, so these are found through Crossref, filtered to preprints from that server.',
  },
  {
    key: 'medrxiv',
    label: 'medRxiv',
    hint: 'Health sciences preprints, found the same way as bioRxiv.',
  },
  {
    key: 'openalex',
    label: 'OpenAlex',
    hint: 'Broad coverage, and the only source of venue standing and citation measures. Requires a free account and meters usage against a daily allowance, which is why it is not the primary source. It also receives the identifiers of results being ranked, so it learns what you are reading, not only what you searched for.',
  },
] as const satisfies readonly SourceRow[];

export function LiteratureSection({ form, setAndCommit }: UseSettingsFormResult): ReactElement {
  const styles = useStyles();
  const { watch, formState } = form;
  const enabled = watch('litEnabled');
  const sources = watch('litSources');
  const models = useModels();
  const installed = (models.data ?? []).map((model) => model.name);

  return (
    <div className={styles.section}>
      <Subtitle2>Literature search</Subtitle2>
      <Field
        label="Literature search"
        hint="Off by default. Nothing reaches the internet until you turn on a source below."
      >
        <Switch
          checked={enabled}
          label={enabled ? 'On' : 'Off'}
          onChange={(_, data) => {
            setAndCommit('litEnabled', data.checked);
          }}
        />
      </Field>

      {!enabled ? null : (
        <>
          <MessageBar intent="info">
            <MessageBarBody>
              Your documents, your index, and your embeddings stay on your machine, and generation
              never uses the network. Literature search is the one exception: it sends only a search
              query you have seen and approved — never your document, your excerpts, or your
              prompts.
            </MessageBarBody>
          </MessageBar>

          <div className={styles.sources}>
            {SOURCES.map(({ key, label, hint }: SourceRow) => (
              <Field key={key} label={label} hint={hint}>
                <Switch
                  checked={sources[key]}
                  label={sources[key] ? 'On' : 'Off'}
                  onChange={(_, data) => {
                    // The whole object is committed rather than a nested path:
                    // `litSources` is one validated field, and splitting it
                    // would let a partial object through the schema.
                    setAndCommit('litSources', { ...sources, [key]: data.checked });
                  }}
                />
              </Field>
            ))}
          </div>

          <Field
            label="Retraction checking (Crossref)"
            hint="Strongly recommended. The only source of typed post-publication notices, so it can tell a correction from a retraction rather than collapsing both into one flag. It receives the DOIs of results being checked."
          >
            <Switch
              checked={watch('litVerification')}
              label={watch('litVerification') ? 'On' : 'Off'}
              onChange={(_, data) => {
                setAndCommit('litVerification', data.checked);
              }}
            />
          </Field>

          <Field
            label="OpenAlex API key"
            hint="Free, and required since February 2026 — keys replaced the old email-based pool. Without one, OpenAlex allows only a trial amount per day and then stops answering, which looks like a search that suddenly finds nothing. Create an account at openalex.org and copy the key from Settings → API."
          >
            <Input
              type="password"
              value={watch('litOpenAlexKey')}
              onChange={(_, data) => {
                form.setValue('litOpenAlexKey', data.value);
              }}
              onBlur={() => {
                setAndCommit('litOpenAlexKey', watch('litOpenAlexKey'));
              }}
              placeholder="Paste your free key"
            />
          </Field>

          <Field
            label="Contact email (optional)"
            hint="Crossref and PubMed ask clients to identify themselves and give faster service to those that do. Blank uses the public pool instead — it is your address, and sending it is a choice. OpenAlex no longer uses this; it wants the key above."
            validationMessage={formState.errors.litContactEmail?.message ?? null}
            validationState={formState.errors.litContactEmail === undefined ? 'none' : 'error'}
          >
            <Input
              value={watch('litContactEmail')}
              onChange={(_, data) => {
                form.setValue('litContactEmail', data.value, { shouldValidate: true });
              }}
              onBlur={() => {
                setAndCommit('litContactEmail', watch('litContactEmail'));
              }}
              placeholder="you@institution.edu"
            />
          </Field>

          <Field
            label="Query drafting model (optional)"
            hint="A normal text model, not an embedding model — it writes keywords from your selected passage, on your machine. Leave as “Same as the general model” unless you want a smaller, faster one for this. Ranking uses the separate embedding model set under Connection."
          >
            <Select
              value={watch('litDraftModel')}
              onChange={(_, data) => {
                setAndCommit('litDraftModel', data.value);
              }}
            >
              <option value="">Same as the general model</option>
              {installed.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </Select>
          </Field>

          <Caption1 className={styles.note}>
            Search results are not cached yet — every search is a fresh request.
          </Caption1>

          <Caption1 className={styles.note}>
            Full text is never fetched from behind a paywall. Papers you cannot read are listed with
            a link so you can decide.
          </Caption1>
        </>
      )}
    </div>
  );
}
