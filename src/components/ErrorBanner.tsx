/** Inline error surface for typed AppErrors (stream failures, action errors). */
import type { ReactElement } from 'react';
import {
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
} from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import type { AppError } from '../types/errors';

export interface ErrorBannerProps {
  error: AppError | null;
  title?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}

export function ErrorBanner({
  error,
  title,
  onRetry,
  onDismiss,
}: ErrorBannerProps): ReactElement | null {
  if (error === null) return null;
  const hasActions = onRetry !== undefined || onDismiss !== undefined;
  return (
    <MessageBar intent="error" layout="multiline">
      <MessageBarBody>
        <MessageBarTitle>{title ?? 'Something went wrong'}</MessageBarTitle>
        {error.message}
      </MessageBarBody>
      {hasActions ? (
        <MessageBarActions
          {...(onDismiss === undefined
            ? {}
            : {
                containerAction: (
                  <Button
                    appearance="transparent"
                    icon={<DismissRegular />}
                    aria-label="Dismiss error"
                    onClick={onDismiss}
                  />
                ),
              })}
        >
          {onRetry === undefined ? null : (
            <Button appearance="secondary" onClick={onRetry}>
              Retry
            </Button>
          )}
        </MessageBarActions>
      ) : null}
    </MessageBar>
  );
}
