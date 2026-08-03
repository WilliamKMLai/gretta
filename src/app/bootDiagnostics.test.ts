import {
  APP_SHELL_ID,
  armCommitWatchdog,
  auditVisibilityChain,
  markAppCommitted,
  markAppMounted,
  paintBootFailure,
  resetBootDiagnosticsForTests,
} from './bootDiagnostics';

const PANEL_ID = 'gretta-boot-overlay';
// jsdom does not implement elementFromPoint (no layout engine) — capture
// defensively and restore-or-delete so each test controls its own stub.
const maybeElementFromPoint = (
  document as { elementFromPoint?: (x: number, y: number) => Element | null }
).elementFromPoint;
const originalElementFromPoint = maybeElementFromPoint?.bind(document);

beforeEach(() => {
  resetBootDiagnosticsForTests();
  document.body.innerHTML = '<div id="root"></div>';
  document.body.removeAttribute('style');
  document.documentElement.removeAttribute('style');
  document.head.querySelectorAll('style[data-test]').forEach((el) => {
    el.remove();
  });
});
afterEach(() => {
  document.getElementById(PANEL_ID)?.remove();
  document.body.innerHTML = '';
  if (originalElementFromPoint) document.elementFromPoint = originalElementFromPoint;
  else Reflect.deleteProperty(document, 'elementFromPoint');
  vi.useRealTimers();
});

function addStyle(css: string): void {
  const tag = document.createElement('style');
  tag.setAttribute('data-test', '');
  tag.textContent = css;
  document.head.appendChild(tag);
}

/** jsdom has no layout — shells stub geometry; probes stub hit-testing. */
function mountShell(size: { width: number; height: number }): HTMLElement {
  const shell = document.createElement('div');
  shell.id = APP_SHELL_ID;
  shell.getBoundingClientRect = () => ({
    ...size,
    top: 0,
    left: 0,
    right: size.width,
    bottom: size.height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  document.getElementById('root')?.appendChild(shell);
  return shell;
}

const panelText = (): string => document.getElementById(PANEL_ID)?.textContent ?? '';

describe('bootDiagnostics reports', () => {
  it('paints a hiding-proof report before mount', () => {
    paintBootFailure('Bootstrap', new Error('boom at start'));
    const panel = document.getElementById(PANEL_ID);
    expect(panel).not.toBeNull();
    expect(panel?.parentElement).toBe(document.documentElement);
    expect(panel?.style.getPropertyPriority('visibility')).toBe('important');
    expect(panelText()).toContain("GRETTA couldn't start");
    expect(panelText()).toContain('Bootstrap: boom at start');
  });

  it('stays visible even when a stylesheet hides <html>', () => {
    addStyle('html{visibility:hidden}');
    paintBootFailure('Bootstrap', new Error('hidden world'));
    expect(document.documentElement.style.getPropertyPriority('visibility')).toBe('important');
    expect(panelText()).toContain('hidden world');
  });

  it('routes uncaught window errors into the panel', () => {
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('module blew up') }));
    expect(panelText()).toContain('module blew up');
  });

  it('keeps painting during the post-schedule grace window', () => {
    markAppMounted();
    paintBootFailure('Uncaught error', new Error('died during commit'));
    expect(panelText()).toContain('died during commit');
  });

  it('never paints once the commit is confirmed', () => {
    markAppMounted();
    markAppCommitted();
    paintBootFailure('Uncaught error', new Error('late async noise'));
    expect(document.getElementById(PANEL_ID)).toBeNull();
  });
});

describe('commit watchdog', () => {
  it('paints a stall report with captured console output when no shell commits', () => {
    vi.useFakeTimers();
    console.warn('stall probe from react');
    markAppMounted();
    armCommitWatchdog(2500);
    vi.advanceTimersByTime(2500);
    expect(panelText()).toContain('nothing committed within 2500 ms');
    expect(panelText()).toContain('[warn] stall probe from react');
  });

  it('confirms a sized, visible, painted shell and stands down', () => {
    vi.useFakeTimers();
    const shell = mountShell({ width: 300, height: 500 });
    const child = document.createElement('span');
    shell.appendChild(child);
    document.elementFromPoint = () => child;
    markAppMounted();
    armCommitWatchdog(2500);
    vi.advanceTimersByTime(2650);
    expect(document.getElementById(PANEL_ID)).toBeNull();
    paintBootFailure('Uncaught error', new Error('post-commit noise'));
    expect(document.getElementById(PANEL_ID)).toBeNull();
  });

  it('self-heals inherited stylesheet hiding with inline !important', () => {
    vi.useFakeTimers();
    addStyle('body{visibility:hidden}');
    const shell = mountShell({ width: 300, height: 500 });
    const child = document.createElement('span');
    shell.appendChild(child);
    document.elementFromPoint = () => child;
    markAppMounted();
    armCommitWatchdog(2500);
    vi.advanceTimersByTime(2500);
    expect(document.body.style.getPropertyPriority('visibility')).toBe('important');
    vi.advanceTimersByTime(150);
    expect(document.getElementById(PANEL_ID)).toBeNull();
    paintBootFailure('Uncaught error', new Error('late noise'));
    expect(document.getElementById(PANEL_ID)).toBeNull();
  });

  it('reports the chain, probe, heals, and culprit rules when still invisible', () => {
    vi.useFakeTimers();
    addStyle('#root{visibility:hidden}');
    mountShell({ width: 300, height: 500 });
    // Paint probe keeps returning something OUTSIDE the shell → occluded/unpainted.
    document.elementFromPoint = () => document.body;
    markAppMounted();
    armCommitWatchdog(2500);
    vi.advanceTimersByTime(2650);
    const text = panelText();
    expect(text).toContain('rendered but is invisible');
    expect(text).toContain('(verdict: outside)');
    expect(text).toContain('BODY (nothing painted above it here)');
    expect(text).toContain('self-heal applied:');
    expect(text).toContain('DIV#root.visibility'); // inherited hiding flags every layer
    expect(text).toContain('#root {visibility: hidden');
  });

  it('reports a zero-size commit with its geometry', () => {
    vi.useFakeTimers();
    mountShell({ width: 0, height: 0 });
    markAppMounted();
    armCommitWatchdog(2500);
    vi.advanceTimersByTime(2650);
    expect(panelText()).toContain('committed at 0×0 px');
  });
});

describe('auditVisibilityChain', () => {
  it('describes every ancestor and flags hidden layers', () => {
    addStyle('body{visibility:hidden}');
    const shell = mountShell({ width: 10, height: 10 });
    const audit = auditVisibilityChain(shell);
    expect(audit.lines.some((line) => line.startsWith('BODY'))).toBe(true);
    expect(audit.hidden.some(({ el, prop }) => el === document.body && prop === 'visibility')).toBe(
      true,
    );
  });
});
