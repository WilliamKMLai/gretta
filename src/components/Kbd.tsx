/** Keyboard-key chip for the shortcuts legend in Settings. */
import type { ReactElement, ReactNode } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: {
    display: 'inline-block',
    padding: `1px ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusSmall,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
});

export function Kbd({ children }: { children: ReactNode }): ReactElement {
  const styles = useStyles();
  return <kbd className={styles.root}>{children}</kbd>;
}
