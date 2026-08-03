/** Settings view: host context line + the live-bound settings form. */
import type { ReactElement } from 'react';
import { Caption1, Subtitle2, makeStyles, tokens } from '@fluentui/react-components';
import { SettingsPanel } from '../../features/settings';
import type { HostInfo } from '../../services/office';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    height: '100%',
    minHeight: 0,
  },
  host: { color: tokens.colorNeutralForeground3 },
  scroll: { flexGrow: 1, minHeight: 0, overflowY: 'auto' },
});

const PLATFORM_LABELS: Record<HostInfo['platform'], string> = {
  PC: 'Windows',
  Mac: 'Mac',
  OfficeOnline: 'Word on the web',
  unknown: 'unknown platform',
};

export interface SettingsViewProps {
  hostInfo: HostInfo;
}

export function SettingsView({ hostInfo }: SettingsViewProps): ReactElement {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <Subtitle2>Settings</Subtitle2>
      <Caption1 className={styles.host}>
        {hostInfo.available
          ? `Running in Word · ${PLATFORM_LABELS[hostInfo.platform]}`
          : 'Browser dev mode — document actions use the built-in sample text.'}
      </Caption1>
      <div className={styles.scroll}>
        <SettingsPanel platform={hostInfo.platform} />
      </div>
    </div>
  );
}
