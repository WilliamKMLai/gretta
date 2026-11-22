#!/usr/bin/env node
/**
 * GRETTA — first-run setup.
 *
 * Why this exists: getting from a stock machine to a working add-in previously
 * meant knowing to install pnpm, then dependencies, then dev certificates, then
 * that Word for Mac cannot reach `http://localhost` from an HTTPS pane and so
 * needs a proxy, then that the Ollama URL in Settings must be changed to point
 * at that proxy. Every one of those is obvious in hindsight and invisible in
 * advance, and missing any of them produces a blank pane or a failed connection
 * check with no useful error.
 *
 * This runs all the checks in order, does what it can, and prints exactly what
 * it could not do and why. It is deliberately chatty: a setup script that
 * succeeds silently teaches nothing, and the person running it is about to have
 * to debug a Word add-in.
 *
 *   node scripts/setup.mjs        # or: pnpm setup
 *
 * It is safe to re-run. Nothing here is destructive.
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const isMac = platform() === 'darwin';
const isWindows = platform() === 'win32';
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const pinnedPnpm =
  typeof pkg.packageManager === 'string' && /^pnpm@[\w.-]+$/u.test(pkg.packageManager)
    ? pkg.packageManager
    : 'pnpm@11.13.1';

const RESET = '\u001b[0m';
const BOLD = '\u001b[1m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';

let failures = 0;

const ok = (message) => {
  console.log(`  ${GREEN}✓${RESET} ${message}`);
};
const warn = (message) => {
  console.log(`  ${YELLOW}!${RESET} ${message}`);
};
const fail = (message) => {
  failures += 1;
  console.log(`  ${RED}✗${RESET} ${message}`);
};
const step = (message) => {
  console.log(`\n${BOLD}${message}${RESET}`);
};
const hint = (message) => {
  console.log(`    ${DIM}${message}${RESET}`);
};

/** Runs a command, returning stdout or null. Never throws. */
function tryRun(command, args) {
  const bin = isWindows && command === 'pnpm' ? 'pnpm.cmd' : command;
  const result = spawnSync(bin, args, { encoding: 'utf8', shell: false });
  if (result.error !== undefined || result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

function run(command) {
  execSync(command, { cwd: repoRoot, stdio: 'inherit' });
}

// ---------------------------------------------------------------------------

console.log(`\n${BOLD}GRETTA setup${RESET}`);
console.log(`${DIM}Local-first writing assistance for Word. Nothing here contacts the internet`);
console.log(`except your package manager.${RESET}`);

step('1. Node');
const [rawMajor = '0', rawMinor = '0'] = process.versions.node.split('.');
const nodeMajor = Number.parseInt(rawMajor, 10);
const nodeMinor = Number.parseInt(rawMinor, 10);
if (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13)) {
  ok(`Node ${process.versions.node}`);
} else {
  fail(`Node ${process.versions.node} is too old — GRETTA needs Node 22.13 or newer.`);
  hint('Install Node from https://nodejs.org, or run this in Terminal: brew install node');
}

step('2. Package manager');
const pnpmVersion = tryRun('pnpm', ['--version']);
if (pnpmVersion !== null) {
  ok(`pnpm ${pnpmVersion}`);
} else {
  warn(`pnpm is not installed. Installing ${pinnedPnpm} now via corepack.`);
  try {
    run(`corepack enable && corepack prepare ${pinnedPnpm} --activate`);
    ok('pnpm installed');
  } catch {
    fail('Could not install pnpm automatically.');
    hint('Run this in Terminal: npm install -g pnpm');
  }
}

step('3. Dependencies');
if (existsSync(join(repoRoot, 'node_modules', '.bin'))) {
  ok('Already installed (re-run `pnpm install` if you changed package.json)');
} else {
  try {
    run('pnpm install');
    ok('Dependencies installed');
  } catch {
    fail('`pnpm install` failed.');
    hint('If it failed building better-sqlite3, run this in Terminal: xcode-select --install');
  }
}

step('4. HTTPS certificate');
// Office requires the task pane over HTTPS, even in development.
const certDir = join(homedir(), '.office-addin-dev-certs');
if (existsSync(join(certDir, 'localhost.crt'))) {
  ok('Development certificate already trusted');
} else {
  const trustPrompt = isMac
    ? 'macOS will ask for your password.'
    : 'your OS may prompt to trust the certificate.';
  warn(`No development certificate found. Creating one — ${trustPrompt}`);
  try {
    run('pnpm certs:install');
  } catch {
    // Falls through to the existence check below, which is the real test.
  }
  // `office-addin-dev-certs` can exit 0 having failed to install the CA — it
  // needs sudo and reports the refusal without a non-zero status. Checking for
  // the file is the only honest verification.
  if (existsSync(join(certDir, 'localhost.crt'))) {
    ok('Certificate installed and trusted');
  } else {
    fail('Certificate installation did not produce a certificate.');
    hint('Run this in Terminal: pnpm certs:install — to see the full error.');
    hint('It needs administrator rights to trust the certificate authority.');
  }
}

step('5. Ollama');
const ollamaVersion = tryRun('ollama', ['--version']);
if (ollamaVersion === null) {
  fail('Ollama is not installed. GRETTA cannot generate anything without it.');
  hint('Install Ollama from https://ollama.com, then run this in Terminal: ollama pull llama3.2');
} else {
  ok(ollamaVersion.replace(/^ollama version is /iu, 'Ollama '));

  const models = tryRun('ollama', ['list']);
  if (models === null) {
    warn('Ollama is installed, but the server is not running.');
    hint('Open the Ollama app or run this in Terminal: ollama serve');
  } else {
    const lines = models
      .split('\n')
      .slice(1)
      .filter((line) => line.trim() !== '');
    if (lines.length === 0) {
      warn('No models installed.');
      hint('A text model is required — run this in Terminal: ollama pull llama3.2');
      hint('An embedding model powers the knowledge base and literature ranking —');
      hint('run this in Terminal: ollama pull nomic-embed-text');
    } else {
      ok(`${String(lines.length)} model${lines.length === 1 ? '' : 's'} installed`);
      // The embedding model is easy to forget: without one, the knowledge base
      // cannot index and literature results fall back to word overlap.
      if (!/embed/iu.test(models)) {
        warn('None of them looks like an embedding model.');
        hint('Run this in Terminal: ollama pull nomic-embed-text');
      }
    }
  }
}

if (isMac) {
  step('6. Mac-specific: the Ollama proxy');
  console.log(`  Word for Mac runs the pane in WKWebView, which blocks an HTTPS page from`);
  console.log(`  calling http://localhost. GRETTA ships a small HTTPS proxy for this, and`);
  console.log(`  ${BOLD}pnpm dev:mac${RESET} starts it for you along with everything else.`);
  ok('No action needed — GRETTA detects the proxy automatically on first connection.');
}

// ---------------------------------------------------------------------------

console.log(`\n${BOLD}${failures === 0 ? 'Ready.' : 'Setup incomplete.'}${RESET}`);
if (failures === 0) {
  console.log(
    `\nNext: run this in Terminal: ${BOLD}${isMac ? 'pnpm dev:mac' : 'pnpm dev'}${RESET}`,
  );
  console.log(
    `${DIM}Then open Word, restart it once when prompted, go to the Home tab, and find GRETTA under Add-ins.${RESET}\n`,
  );
} else {
  const noun = failures === 1 ? 'thing above needs' : 'things above need';
  console.log(
    `\n${String(failures)} ${noun} attention. ` +
      `Fix ${failures === 1 ? 'it' : 'them'} and run ${BOLD}pnpm setup${RESET} again.\n`,
  );
  process.exitCode = 1;
}
