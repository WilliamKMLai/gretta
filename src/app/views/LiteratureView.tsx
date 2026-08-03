/** Literature discovery view (ADR-028). Off by default; opened from the header. */
import type { ReactElement } from 'react';
import { LiteraturePanel } from '../../features/literature';

export function LiteratureView(): ReactElement {
  return <LiteraturePanel />;
}
