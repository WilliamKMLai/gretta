/** Centered placeholder for empty views (idle response area, no history). */
import type { ReactElement, ReactNode } from 'react';
import { Body1, Subtitle2, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXL,
    color: tokens.colorNeutralForeground3,
    height: '100%',
  },
  icon: { fontSize: '28px', lineHeight: 1 },
});

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, body, action }: EmptyStateProps): ReactElement {
  const styles = useStyles();
  return (
    <div className={styles.root} role="status">
      {icon === undefined ? null : (
        <span aria-hidden="true" className={styles.icon}>
          {icon}
        </span>
      )}
      <Subtitle2>{title}</Subtitle2>
      {body === undefined ? null : <Body1>{body}</Body1>}
      {action}
    </div>
  );
}
