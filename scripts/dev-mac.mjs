#!/usr/bin/env node
/**
 * GRETTA — one-command Mac development loader.
 *
 * Why this exists: developing the add-in on Mac previously meant juggling three
 * things by hand — start the Vite dev server (`pnpm dev`), start the HTTPS→Ollama
 * proxy in a *second* terminal (`pnpm proxy`, required because Word for Mac's
 * WKWebView blocks the HTTPS pane from calling http://localhost, ADR-008), and
 * copy the manifest into Word's `wef` folder. Forgetting any one produced a
 * blank pane or a dead connection check with no obvious cause. This script does
 * all three from a single `pnpm dev:mac`, streams both servers' logs under
 * colored prefixes, and tears everything down together on Ctrl+C.
 *
 * The one step it cannot do for you: Word only reads the `wef` folder at launch,
 * so a running Word must be restarted after the first sideload. The script says
 * so, loudly, at the end of startup.
 *
 * Usage:
 *   pnpm dev:mac                 # sideload + dev + proxy + kb, then restart Word once
 *   pnpm dev:mac --no-sideload   # skip the manifest copy (already sideloaded)
 *
 * Guard: refuses to run on non-Mac hosts, where the `wef` path and the proxy
 * rationale do not apply (Windows/web use their own sideload flows — see
 * docs/SIDELOADING.md). Override with GRETTA_FORCE=1 if you know better.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestSource = join(repoRoot, 'manifest', 'manifest.xml');
const wefDir = join(
  homedir(),
  'Library',
  'Containers',
  'com.microsoft.Word',
  'Data',
  'Documents',
  'wef',
);

const skipSideload = process.argv.includes('--no-sideload');

// ── tiny ANSI helpers (no dependency) ────────────────────────────────────────
const paint = (code, text) => `\u001b[${code}m${text}\u001b[0m`;
const bold = (text) => paint('1', text);
const dim = (text) => paint('2', text);
const cyan = (text) => paint('36', text);
const magenta = (text) => paint('35', text);
const green = (text) => paint('32', text);
const red = (text) => paint('31', text);
const yellow = (text) => paint('33', text);

function fail(message, hint) {
  console.error(`\n${red('✖ dev:mac')} ${message}`);
  if (hint) console.error(`  ${dim(hint)}`);
  process.exit(1);
}

// ── guard: this flow is Mac-only ─────────────────────────────────────────────
if (platform() !== 'darwin' && process.env.GRETTA_FORCE !== '1') {
  fail(
    'This loader is for Word on Mac.',
    'Windows and web use different sideload flows — see docs/SIDELOADING.md. Set GRETTA_FORCE=1 to override.',
  );
}

// ── step 1: sideload the manifest into Word's wef folder ─────────────────────
function sideload() {
  if (skipSideload) {
    console.log(dim('› Skipping manifest sideload (--no-sideload).'));
    return;
  }
  if (!existsSync(manifestSource)) {
    fail(`Manifest not found at ${manifestSource}`, 'Run from the repo root.');
  }
  mkdirSync(wefDir, { recursive: true });
  copyFileSync(manifestSource, join(wefDir, 'manifest.xml'));
  console.log(`${green('✓')} Sideloaded manifest → ${dim(wefDir)}`);
}

// ── step 2: run dev + proxy as children, streaming prefixed logs ──────────────
/** A supervised child process, its output line-prefixed with a colored label. */
function launch(label, colorFn, command, args) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = colorFn(`[${label}]`);
  const forward = (stream, sink) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) sink(`${prefix} ${line}`);
    });
  };
  forward(child.stdout, (line) => {
    console.log(line);
  });
  forward(child.stderr, (line) => {
    console.error(line);
  });
  return child;
}

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${dim('› Shutting down dev server, proxy, and knowledge-base companion…')}`);
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  // Give children a moment to exit cleanly, then force the process to end.
  setTimeout(() => {
    process.exit(code);
  }, 400);
}

// If either server dies on its own, take the whole thing down — a half-running
// setup (dev up, proxy dead) is the confusing state this script exists to avoid.
function superviseExit(label) {
  return (code) => {
    if (shuttingDown) return;
    console.error(`\n${red('✖')} ${bold(label)} exited unexpectedly (code ${String(code)}).`);
    shutdown(1);
  };
}

// ── run ──────────────────────────────────────────────────────────────────────
sideload();

const dev = launch('dev', cyan, 'pnpm', ['dev']);
const proxy = launch('proxy', magenta, 'pnpm', ['proxy']);
// The knowledge-base companion (ADR-020) serves RAG indexing/retrieval on
// https://localhost:11436. It is opt-in in the pane, but running it here keeps
// "one command" true for anyone using the feature.
const kb = launch('kb', green, 'pnpm', ['kb']);
children.push(dev, proxy, kb);
dev.on('exit', superviseExit('Dev server'));
proxy.on('exit', superviseExit('Proxy'));
kb.on('exit', superviseExit('Knowledge-base companion'));

process.on('SIGINT', () => {
  shutdown(0);
});
process.on('SIGTERM', () => {
  shutdown(0);
});

// The one manual step, made impossible to miss.
const banner = [
  '',
  yellow('┌───────────────────────────────────────────────────────────────┐'),
  `${yellow('│')}  ${bold('One step left: restart Word.')}                                 ${yellow('│')}`,
  `${yellow('│')}  ${dim('Word only reads the add-in folder at launch, so quit Word')}    ${yellow('│')}`,
  `${yellow('│')}  ${dim('completely (⌘Q) and reopen it. Then: Home → Add-ins →')}       ${yellow('│')}`,
  `${yellow('│')}  ${dim('GRETTA. Set the Ollama URL to')} ${cyan('https://localhost:11435')}${yellow('     │')}`,
  `${yellow('└───────────────────────────────────────────────────────────────┘')}`,
  dim('  Both servers are running above. Press Ctrl+C to stop them.'),
  '',
];
// Print after a short delay so it lands below the servers' own startup noise.
setTimeout(() => {
  if (!shuttingDown) console.log(banner.join('\n'));
}, 1500);
