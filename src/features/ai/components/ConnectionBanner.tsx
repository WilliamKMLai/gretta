/**
 * Connectivity guidance (ARCHITECTURE.md §10), driven by the health poll's
 * typed errors — offline, CORS/mixed-content (with the Mac proxy walkthrough,
 * ADR-008), timeout, and everything else, each with a concrete next step.
 */
import type { ReactElement } from 'react';
import {
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
} from '@fluentui/react-components';
import type { HostInfo } from '../../../services/office';
import { describeOllamaError, type OllamaGuidance } from '../../../types/errors';
import { useSettingsStore } from '../../settings';
import { useOllamaHealth } from '../../../hooks/useOllamaQueries';

export interface ConnectionBannerProps {
  platform: HostInfo['platform'];
  onOpenSettings?: () => void;
}

function guidanceFor(error: unknown, url: string, platform: HostInfo['platform']): OllamaGuidance {
  return describeOllamaError(error, { url, isMac: platform === 'Mac' });
}

export function ConnectionBanner({
  platform,
  onOpenSettings,
}: ConnectionBannerProps): ReactElement | null {
  const health = useOllamaHealth();
  const url = useSettingsStore((state) => state.ollamaUrl);
  if (!health.isError) return null;

  const guidance = guidanceFor(health.error, url, platform);
  return (
    <MessageBar intent="warning" layout="multiline">
      <MessageBarBody>
        <MessageBarTitle>{guidance.title}</MessageBarTitle>
        {guidance.body}
      </MessageBarBody>
      <MessageBarActions>
        <Button
          appearance="secondary"
          size="small"
          onClick={() => {
            void health.refetch();
          }}
        >
          Retry
        </Button>
        {onOpenSettings === undefined ? null : (
          <Button appearance="secondary" size="small" onClick={onOpenSettings}>
            Open settings
          </Button>
        )}
      </MessageBarActions>
    </MessageBar>
  );
}
