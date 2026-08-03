#!/usr/bin/env node
/**
 * GRETTA boot smoke: executes the REAL production bundle (dist/) inside a
 * scripted jsdom window and reports whether the app reaches a rendered shell.
 *
 * Why it exists: Word's webview console is invisible, so "blank pane" reports
 * carry no stack. This proves, outside vitest's shims, whether the built
 * module graph can evaluate + bootstrap + render at all. A failure here
 * reproduces the crash with a stack; a pass localizes the problem to the
 * environment (stale cache, missing install, unreachable dev server).
 *
 * Usage:  pnpm build && node scripts/boot-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const html = readFileSync(join(distDir, 'taskpane.html'), 'utf8');

const entryMatch = /<script[^>]*type="module"[^>]*src="([^"]+\.js)"/.exec(html);
if (entryMatch === null) {
  console.error('[boot-smoke] FAIL: no module entry found in dist/taskpane.html');
  process.exit(1);
}
const entryPath = join(distDir, entryMatch[1].replace(/^\//, ''));

const problems = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => problems.push(`jsdomError: ${error.message}`));
virtualConsole.on('error', (...args) => problems.push(`console.error: ${args.join(' ')}`));
virtualConsole.on('warn', () => undefined);
virtualConsole.on('log', () => undefined);

// Strip the office.js CDN tag (no network here): Office stays undefined, which
// is exactly the browser-mode path detectHostInfo is designed to take.
const dom = new JSDOM(html.replace(/<script src="https:\/\/appsforoffice[^<]*<\/script>/, ''), {
  url: 'https://localhost:3000/taskpane.html',
  pretendToBeVisual: true,
  virtualConsole,
});

// Adopt the jsdom window as the global environment (what vitest does for us).
const { window } = dom;
for (const key of Object.getOwnPropertyNames(window)) {
  if (!(key in globalThis)) {
    try {
      globalThis[key] = window[key];
    } catch {
      /* read-only global — irrelevant for boot */
    }
  }
}
function defineGlobal(key, value) {
  try {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  } catch {
    /* getter-only Node global — keep jsdom's copy reachable via window.* */
  }
}
defineGlobal('window', window);
defineGlobal('document', window.document);
defineGlobal('navigator', window.navigator);

// The same minimal shims the browser has but jsdom lacks (mirrors tests/setup.ts).
window.matchMedia ??= () => ({
  matches: false,
  media: '',
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  onchange: null,
  dispatchEvent: () => false,
});
defineGlobal('matchMedia', window.matchMedia);
class ResizeObserverStub {
  observe() {
    /* jsdom stub — layout is irrelevant to boot */
  }
  unobserve() {
    /* jsdom stub */
  }
  disconnect() {
    /* jsdom stub */
  }
}
window.ResizeObserver ??= ResizeObserverStub;
defineGlobal('ResizeObserver', window.ResizeObserver);

// Vite's modulepreload polyfill probes relList.supports('modulepreload') and,
// in jsdom (no support), would fetch every preload from the page origin —
// a harness artifact real webviews don't hit. Claim native support instead.
if (window.DOMTokenList?.prototype !== undefined) {
  window.DOMTokenList.prototype.supports = () => true;
}

// App promise rejections happen in the NODE realm here (the bundle runs via
// Node ESM), so window listeners never see them — capture at the process.
process.on('unhandledRejection', (reason) => {
  problems.push(`unhandledRejection: ${reason?.stack ?? String(reason)}`);
});
process.on('uncaughtException', (error) => {
  problems.push(`uncaughtException: ${error?.stack ?? String(error)}`);
});

window.addEventListener('error', (event) => {
  problems.push(`window.onerror: ${event.error?.stack ?? event.message}`);
});
window.addEventListener('unhandledrejection', (event) => {
  problems.push(`unhandledrejection: ${event.reason?.stack ?? String(event.reason)}`);
});

try {
  await import(pathToFileURL(entryPath).href);
} catch (error) {
  console.error('[boot-smoke] FAIL: module graph threw during evaluation:');
  console.error(error?.stack ?? error);
  process.exit(1);
}

// bootstrap: detectHostInfo resolves immediately (Office undefined), render,
// health query fires and fails fast (ECONNREFUSED) into the banner path.
await sleep(2000);

// NOTE: jsdom has no layout engine — this smoke validates DOM presence only.
// "Committed but zero visible pixels" (the class of bug behind the 2026-07-17
// blank pane) is invisible here; the in-app commit watchdog covers geometry.
// Computed-visibility audit: jsdom applies stylesheet cascade for these
// properties, so a rule hiding a structural ancestor shows up here even
// without a layout engine.
{
  let node = window.document.getElementById('gretta-app');
  while (node !== null) {
    const cs = window.getComputedStyle(node);
    console.log(
      `[boot-smoke] chain ${node.tagName}${node.id ? '#' + node.id : ''}: ` +
        `display=${cs.display} visibility=${cs.visibility} opacity=${cs.opacity}`,
    );
    node = node.parentElement;
  }
  const styleTags = window.document.querySelectorAll('style');
  console.log(`[boot-smoke] style tags: ${styleTags.length}`);
  for (const tag of styleTags) {
    const text = tag.textContent ?? '';
    if (/(html|body|#root)[^{]*\{[^}]*(visibility|display\s*:\s*none|opacity)/i.test(text)) {
      console.log(`[boot-smoke] SUSPICIOUS RULE: ${text.slice(0, 200)}`);
    }
  }
}
const rootText = window.document.getElementById('root')?.textContent ?? '';
const shellUp = rootText.includes('GRETTA');
const errorPanel = window.document.querySelector('[role="alert"]');
const bootPanel = (window.document.documentElement.textContent ?? '').includes("couldn't start");

console.log(`[boot-smoke] shell rendered: ${shellUp}`);
console.log(`[boot-smoke] boot-failure panel: ${bootPanel}`);
if (errorPanel !== null && !shellUp) {
  console.log(`[boot-smoke] alert content: ${errorPanel.textContent?.slice(0, 300)}`);
}
const fatal = problems.filter((p) => !p.includes('11434')); // Ollama-off is the expected failure
if (fatal.length > 0) {
  console.log('[boot-smoke] captured problems:');
  for (const p of fatal) console.log(`  - ${p.split('\n').slice(0, 4).join('\n    ')}`);
}
if (shellUp && !bootPanel) {
  console.log('[boot-smoke] PASS — the built bundle boots to the GRETTA shell.');
  process.exit(0);
}
console.error('[boot-smoke] FAIL — bundle did not reach the shell.');
process.exit(1);
