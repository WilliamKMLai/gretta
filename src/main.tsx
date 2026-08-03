/**
 * Task-pane entry point. bootDiagnostics is imported FIRST so crash surfaces
 * install before the app's module graph evaluates (ARCHITECTURE.md §12); the
 * Office host is then resolved before the first render so the tree never
 * flashes between modes (§5.3). Every failure path paints a visible report —
 * a blank pane is never an acceptable outcome.
 */
import {
  APP_SHELL_ID,
  armCommitWatchdog,
  markAppMounted,
  noteBootInfo,
  paintBootFailure,
} from './app/bootDiagnostics';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { AppErrorBoundary } from './app/AppErrorBoundary';
import { initServices } from './app/services';
import { detectHostInfo } from './services/office';
import './styles/global.css';

async function bootstrap(): Promise<void> {
  const hostInfo = await detectHostInfo();
  noteBootInfo(
    `host=${hostInfo.host} available=${String(hostInfo.available)} platform=${hostInfo.platform} mode=${import.meta.env.MODE}`,
  );
  initServices(hostInfo);
  const container = document.getElementById('root');
  if (container === null) {
    throw new Error('GRETTA: taskpane.html is missing the #root element.');
  }
  // React 18/19 createRoot does not clear pre-existing children — remove the
  // static build-stamp placeholder ourselves (bootDiagnostics clears it too).
  document.getElementById('boot-placeholder')?.remove();

  // Differential boot probe: ?bare=1 renders a minimal pure-React tree with no
  // Fluent, stores, or theme. If THIS commits where the full app goes white,
  // the failure lives inside the app tree; if even this stays white, React's
  // commit itself is failing in the environment. Permanent debug affordance.
  if (new URLSearchParams(location.search).has('bare')) {
    createRoot(container).render(
      <StrictMode>
        <div id={APP_SHELL_ID} style={{ font: '14px -apple-system, sans-serif', padding: 16 }}>
          Bare boot OK — React committed. The failure is inside the app tree (Fluent / stores /
          theme), not React or the environment.
        </div>
      </StrictMode>,
    );
    markAppMounted();
    armCommitWatchdog();
    return;
  }

  createRoot(container).render(
    <StrictMode>
      <AppErrorBoundary>
        <App hostInfo={hostInfo} />
      </AppErrorBoundary>
    </StrictMode>,
  );
  markAppMounted();
  armCommitWatchdog();
}

bootstrap().catch((error: unknown) => {
  console.error('[GRETTA] failed to start', error);
  paintBootFailure('Bootstrap', error);
});
