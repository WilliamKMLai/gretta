/**
 * Boot + visibility diagnostics (ARCHITECTURE.md §12 — a pane that cannot
 * start, or cannot be SEEN, must still explain itself). main.tsx imports this
 * module first so surfaces install before the app's module graph evaluates.
 *
 * Coverage, in order of where things can die:
 *  1. Module-eval / bootstrap crashes → window handlers paint a report.
 *  2. React schedules but never commits → watchdog stall report.
 *  3. Commits at zero size → self-heal inline hiding, else report.
 *  4. Commits SIZED but invisible (inherited visibility/opacity from a
 *     stylesheet — preserves layout, defeats size checks, and hides anything
 *     appended inside <body>) → audit the computed chain + paint-probe via
 *     elementFromPoint, self-heal with inline !important, else report.
 *
 * Reports are hiding-proof by construction: attached to <html> itself
 * (outside <body>'s cascade) with inline !important visibility/opacity —
 * which outranks even stylesheet !important. They carry the console ring,
 * the computed ancestor chain, every stylesheet rule that targets
 * html/body/#root with hiding properties (verbatim), and the user agent.
 */

const POST_SCHEDULE_GRACE_MS = 10_000;
const COMMIT_WATCHDOG_MS = 2_500;
const REMEASURE_DELAY_MS = 150;
export const APP_SHELL_ID = 'gretta-app';
const PANEL_ID = 'gretta-boot-overlay';

const RING_CAPACITY = 25;
const consoleRing: string[] = [];

function record(level: string, args: unknown[]): void {
  const text = args
    .map((value) => (value instanceof Error ? (value.stack ?? value.message) : String(value)))
    .join(' ')
    .slice(0, 600);
  consoleRing.push(`[${level}] ${text}`);
  if (consoleRing.length > RING_CAPACITY) consoleRing.shift();
}

const originalError = console.error.bind(console);
const originalWarn = console.warn.bind(console);
console.error = (...args: unknown[]): void => {
  record('error', args);
  originalError(...args);
};
console.warn = (...args: unknown[]): void => {
  record('warn', args);
  originalWarn(...args);
};

/** Boot facts (host detection result, mode) folded into every report. */
export function noteBootInfo(text: string): void {
  record('boot', [text]);
}

let scheduledAt: number | null = null;
let committed = false;

export function markAppMounted(): void {
  scheduledAt = Date.now();
}

export function markAppCommitted(): void {
  committed = true;
}

export function resetBootDiagnosticsForTests(): void {
  scheduledAt = null;
  committed = false;
  consoleRing.length = 0;
  document.getElementById(PANEL_ID)?.remove();
}

/** Inline !important — outranks any stylesheet, including sheet !important. */
function forceVisible(el: HTMLElement): void {
  el.style.setProperty('visibility', 'visible', 'important');
  el.style.setProperty('opacity', '1', 'important');
}

function describe(error: unknown): { message: string; stack: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack ?? '' };
  return { message: String(error), stack: '' };
}

interface ChainAudit {
  lines: string[];
  hidden: { el: HTMLElement; prop: 'visibility' | 'opacity' | 'display' }[];
}

/** Walks el → <html>, describing computed style and flagging hiders. */
export function auditVisibilityChain(start: HTMLElement | null): ChainAudit {
  const lines: string[] = [];
  const hidden: ChainAudit['hidden'] = [];
  let node: HTMLElement | null = start;
  while (node !== null) {
    const cs = window.getComputedStyle(node);
    const opacity = Number.parseFloat(cs.opacity);
    const rect = node.getBoundingClientRect();
    const label = `${node.tagName}${node.id ? `#${node.id}` : ''}`;
    lines.push(
      `${label}: ${String(Math.round(rect.width))}×${String(Math.round(rect.height))}` +
        `@${String(Math.round(rect.x))},${String(Math.round(rect.y))} ` +
        `display=${cs.display} visibility=${cs.visibility} opacity=${cs.opacity || '1'} ` +
        `pointer-events=${cs.pointerEvents}`,
    );
    if (cs.visibility === 'hidden') hidden.push({ el: node, prop: 'visibility' });
    if (!Number.isNaN(opacity) && opacity < 0.05) hidden.push({ el: node, prop: 'opacity' });
    if (cs.display === 'none') hidden.push({ el: node, prop: 'display' });
    node = node.parentElement;
  }
  return { lines, hidden };
}

/** Verbatim stylesheet rules that could hide the structural elements. */
function suspiciousRules(): string[] {
  const found: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet — unreadable, note nothing
    }
    for (const rule of Array.from(rules)) {
      const selector = 'selectorText' in rule ? (rule as CSSStyleRule).selectorText : '';
      if (
        /(^|,\s*)(html|body|#root)\b/.test(selector) &&
        /(visibility|opacity|display\s*:\s*none)/.test(rule.cssText)
      ) {
        found.push(rule.cssText.slice(0, 220));
        if (found.length >= 4) return found;
      }
    }
  }
  return found;
}

function renderPanel(headline: string, detail: string, body: string): void {
  document.getElementById(PANEL_ID)?.remove();
  // <html> gets force-shown too: display:none on an ancestor cannot be
  // overridden from a child, and html is the panel's only ancestor.
  const host = document.documentElement;
  host.style.setProperty('display', 'block', 'important');
  forceVisible(host);

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'alert');
  panel.style.cssText =
    'position:fixed;top:0;left:0;right:0;max-height:75%;overflow:auto;box-sizing:border-box;' +
    'padding:16px;font:13px/1.5 -apple-system,"Segoe UI",sans-serif;' +
    'background:#fef2f2;color:#7f1d1d;border-bottom:2px solid #7f1d1d;z-index:2147483647;';
  forceVisible(panel);

  const title = document.createElement('div');
  title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:8px;';
  title.textContent = headline;

  const detailEl = document.createElement('div');
  detailEl.textContent = detail;

  const pre = document.createElement('pre');
  pre.style.cssText =
    'white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;border:1px solid #fecaca;' +
    'border-radius:4px;padding:8px;margin:12px 0;font-size:11px;max-height:55vh;overflow:auto;';
  const buffered =
    consoleRing.length === 0 ? '(no console output captured)' : consoleRing.slice(-10).join('\n');
  pre.textContent = `${body}\n\n— recent console output —\n${buffered}\n\n— environment —\n${navigator.userAgent}`;

  const hint = document.createElement('div');
  hint.style.cssText = 'margin-bottom:12px;';
  hint.textContent = 'Copy the details above when reporting this, then try reloading the pane.';

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload pane';
  reload.style.cssText =
    'padding:6px 14px;border:1px solid #7f1d1d;border-radius:4px;background:#fff;color:#7f1d1d;font:inherit;cursor:pointer;';
  reload.addEventListener('click', () => {
    location.reload();
  });

  panel.append(title, detailEl, pre, hint, reload);
  host.append(panel);
}

export function paintBootFailure(phase: string, error: unknown): void {
  if (committed) return;
  if (scheduledAt !== null && Date.now() - scheduledAt > POST_SCHEDULE_GRACE_MS) return;
  const { message, stack } = describe(error);
  renderPanel(
    "GRETTA couldn't start",
    `${phase}: ${message}`,
    stack === '' ? '(no stack trace available)' : stack,
  );
}

function describeTarget(el: Element): string {
  const rect = el.getBoundingClientRect();
  const cs = window.getComputedStyle(el);
  const cls = el.classList.length > 0 ? `.${Array.from(el.classList).slice(0, 2).join('.')}` : '';
  return (
    `${el.tagName}${el.id ? `#${el.id}` : ''}${cls} ` +
    `${String(Math.round(rect.width))}×${String(Math.round(rect.height))}` +
    `@${String(Math.round(rect.x))},${String(Math.round(rect.y))} ` +
    `pos=${cs.position} z=${cs.zIndex} bg=${cs.backgroundColor} pe=${cs.pointerEvents}`
  );
}

/** Hit test at one point; names what the browser says is painted there. */
function probeAt(x: number, y: number, shell: HTMLElement): { verdict: string; line: string } {
  const at = `(${String(Math.round(x))},${String(Math.round(y))})`;
  if (typeof document.elementFromPoint !== 'function') {
    return { verdict: 'inconclusive', line: `${at} → API absent` };
  }
  const target = document.elementFromPoint(x, y);
  if (target === null) return { verdict: 'inconclusive', line: `${at} → null (off-viewport?)` };
  if (target.id === PANEL_ID || shell.contains(target)) {
    return { verdict: 'inside', line: `${at} → inside shell: ${describeTarget(target)}` };
  }
  if (target === document.body || target === document.documentElement) {
    return {
      verdict: 'outside',
      line: `${at} → ${target.tagName} (nothing painted above it here)`,
    };
  }
  return { verdict: 'outside', line: `${at} → OCCLUDER: ${describeTarget(target)}` };
}

/** Multi-point hit test: 'inside' | 'outside' | 'inconclusive' + evidence. */
function paintProbe(shell: HTMLElement): { verdict: string; lines: string[] } {
  const rect = shell.getBoundingClientRect();
  const points: [number, number][] = [
    [rect.left + rect.width / 2, rect.top + Math.min(24, rect.height / 2)],
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [window.innerWidth / 2, window.innerHeight / 2],
  ];
  const results = points.map(([x, y]) => probeAt(x, y, shell));
  const verdict = results.some((r) => r.verdict === 'inside')
    ? 'inside'
    : results.every((r) => r.verdict === 'inconclusive')
      ? 'inconclusive'
      : 'outside';
  return { verdict, lines: results.map((r) => r.line) };
}

/** Every direct child of <body> — portals and overlays show up here. */
function bodyInventory(): string[] {
  return Array.from(document.body.children)
    .slice(0, 12)
    .map((el) => describeTarget(el));
}

function reportInvisible(
  verdict: string,
  audit: ChainAudit,
  probe: { verdict: string; lines: string[] },
  healed: string[],
  shell: HTMLElement,
): void {
  const rules = suspiciousRules();
  const text = shell.textContent.slice(0, 80).replace(/\s+/g, ' ');
  renderPanel(
    'GRETTA rendered but is invisible',
    verdict,
    [
      `viewport ${String(window.innerWidth)}×${String(window.innerHeight)} scroll ${String(Math.round(window.scrollX))},${String(Math.round(window.scrollY))}`,
      '— computed chain (shell → html) —',
      ...audit.lines,
      `— paint probes (verdict: ${probe.verdict}) —`,
      ...probe.lines,
      '— <body> direct children —',
      ...bodyInventory(),
      `shell census: ${String(shell.childElementCount)} children, text[0..80]="${text}"`,
      healed.length === 0
        ? 'self-heal: nothing applicable'
        : `self-heal applied: ${healed.join(', ')}`,
      rules.length === 0
        ? 'no stylesheet rules target html/body/#root with hiding properties'
        : `— suspicious stylesheet rules —\n${rules.join('\n')}`,
    ].join('\n'),
  );
}

export function armCommitWatchdog(timeoutMs: number = COMMIT_WATCHDOG_MS): void {
  window.setTimeout(() => {
    const shell = document.getElementById(APP_SHELL_ID);
    if (shell === null) {
      renderPanel(
        "GRETTA couldn't start",
        `React scheduled the UI but nothing committed within ${String(timeoutMs)} ms — the captured console output below usually names the reason.`,
        auditVisibilityChain(document.getElementById('root')).lines.join('\n'),
      );
      return;
    }

    const finish = (): void => {
      const audit = auditVisibilityChain(shell);
      const probe = paintProbe(shell);
      const rect = shell.getBoundingClientRect();
      const sized = rect.width >= 2 && rect.height >= 2;
      if (sized && audit.hidden.length === 0 && probe.verdict !== 'outside') {
        markAppCommitted();
        return;
      }
      // Self-heal: inline !important on every flagged ancestor.
      const healed: string[] = [];
      for (const { el, prop } of audit.hidden) {
        if (prop === 'display') el.style.setProperty('display', 'block', 'important');
        else if (prop === 'visibility') el.style.setProperty('visibility', 'visible', 'important');
        else el.style.setProperty('opacity', '1', 'important');
        healed.push(`${el.tagName}${el.id ? `#${el.id}` : ''}.${prop}`);
      }
      window.setTimeout(() => {
        const after = auditVisibilityChain(shell);
        const afterProbe = paintProbe(shell);
        const afterRect = shell.getBoundingClientRect();
        const ok =
          afterRect.width >= 2 &&
          afterRect.height >= 2 &&
          after.hidden.length === 0 &&
          afterProbe.verdict !== 'outside';
        if (ok && healed.length > 0) {
          record('warn', [`bootDiagnostics: self-healed hidden layers [${healed.join(', ')}]`]);
          markAppCommitted();
          return;
        }
        if (ok) {
          markAppCommitted();
          return;
        }
        reportInvisible(
          afterRect.width < 2 || afterRect.height < 2
            ? `The app tree committed at ${String(Math.round(afterRect.width))}×${String(Math.round(afterRect.height))} px.`
            : 'The app tree committed with size but does not paint — the forensics below locate the failure.',
          after,
          afterProbe,
          healed,
          shell,
        );
      }, REMEASURE_DELAY_MS);
    };
    finish();
  }, timeoutMs);
}

window.addEventListener('error', (event) => {
  paintBootFailure('Uncaught error', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  paintBootFailure('Unhandled promise rejection', event.reason);
});
