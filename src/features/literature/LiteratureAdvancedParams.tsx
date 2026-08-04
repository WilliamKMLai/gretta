/**
 * Advanced search parameters: year filter, results-per-source pool size, the
 * venue citation caution threshold, and the citation-impact ranking weight
 * (DECISIONS.md ADR-029). Split out of `LiteraturePanel.tsx` to keep that
 * file under the file-size convention.
 */
import type { ReactElement } from 'react';
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Field,
  Input,
  SpinButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { SpinButtonOnChangeData } from '@fluentui/react-components';
import { useSettingsStore } from '../settings';
import { useLiteratureStore } from './literature.store';

/**
 * SpinButton reports either a number or the typed display string. `SpinButton`
 * replaces a clamped `Input` here to fix a real bug: clamping on every
 * keystroke snapped the value back to its minimum after the first digit,
 * making a number like `20` untypeable one digit at a time.
 */
function spinValue(data: SpinButtonOnChangeData): number | null {
  if (typeof data.value === 'number') return data.value;
  if (data.displayValue !== undefined) {
    const parsed = Number(data.displayValue);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

const useStyles = makeStyles({
  // Pinned like every other direct child of the panel's scrolling column —
  // see LiteraturePanel.tsx.
  root: { flexShrink: 0 },
  advanced: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    paddingTop: tokens.spacingVerticalS,
  },
});

export function LiteratureAdvancedParams(): ReactElement {
  const styles = useStyles();
  const fromYear = useLiteratureStore((state) => state.fromYear);
  const setFromYear = useLiteratureStore((state) => state.setFromYear);
  const resultsPerSource = useSettingsStore((state) => state.litResultsPerSource);
  const minVenueCitedness = useSettingsStore((state) => state.litMinVenueCitedness);
  const citationImpactWeight = useSettingsStore((state) => state.litCitationImpactWeight);
  const setSettings = useSettingsStore((state) => state.setSettings);

  return (
    <Accordion className={styles.root} collapsible>
      <AccordionItem value="advanced">
        <AccordionHeader size="small">Advanced search parameters</AccordionHeader>
        <AccordionPanel>
          <div className={styles.advanced}>
            <Field
              label="Published since"
              hint="A filter you set, not a weight GRETTA applies. Blank means no date bound."
            >
              <Input
                type="number"
                value={fromYear === null ? '' : String(fromYear)}
                placeholder="e.g. 2022"
                onChange={(_, data) => {
                  const parsed = Number.parseInt(data.value, 10);
                  setFromYear(Number.isFinite(parsed) ? parsed : null);
                }}
              />
            </Field>

            <Field
              label="Results per source"
              hint="Candidates fetched before ranking trims them. Ranking is precision over this pool and cannot reach past it, so a wider pool finds more — at the cost of a slower search and more embedding work."
            >
              <SpinButton
                min={5}
                max={100}
                step={5}
                value={resultsPerSource}
                onChange={(_, data) => {
                  const value = spinValue(data);
                  if (value !== null) {
                    setSettings({ litResultsPerSource: Math.round(value) });
                  }
                }}
              />
            </Field>

            <Field
              label="Venue citation threshold"
              hint="A journal that charges to publish, is absent from DOAJ, and is cited less often than this draws a caution. The default is provisional — it was chosen without real result sets behind it, so tune it rather than trust it."
            >
              <SpinButton
                min={0}
                max={50}
                step={0.1}
                value={minVenueCitedness}
                onChange={(_, data) => {
                  const value = spinValue(data);
                  if (value !== null) {
                    setSettings({ litMinVenueCitedness: Math.round(value * 10) / 10 });
                  }
                }}
              />
            </Field>

            <Field
              label="Citation impact weight"
              hint="How much a result's citation impact for its year (OpenAlex) can nudge it up the ranking. 0 turns the nudge off — pure relevance, as before. It only breaks close calls: a clearly more relevant result still wins regardless of this value. Provisional — chosen without real result sets behind it, so tune it rather than trust it."
            >
              <SpinButton
                min={0}
                max={1}
                step={0.05}
                value={citationImpactWeight}
                onChange={(_, data) => {
                  const value = spinValue(data);
                  if (value !== null) {
                    setSettings({ litCitationImpactWeight: Math.round(value * 100) / 100 });
                  }
                }}
              />
            </Field>
          </div>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}
