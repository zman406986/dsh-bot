// dev/browser-serve.mjs — hold a mock-backed dsh web server open for a browser pass.
//
// Unlike dev/e2e-mock.mjs (which asserts and exits), this boots the same
// mock + real `dsh --profile web --patch dev/cordis.web.patch.yml` pair and
// WAITS, printing the tokenized URL so a browser can attach. It arms the same
// kill timer at launch and tears everything down on Ctrl+C or when the timer
// fires.
//
//   node dev/browser-serve.mjs [--timeout-ms 900000] [--out <dir>]
//
// The mock answers every model turn with a fixed scripted reply, so nothing
// reaches the network. Credentials: DEEPSEEK_API_KEY is a literal mock key.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { assertBuildFresh } from './build-freshness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const MOCK = join(HERE, 'mock-llm.mjs');
const OVERLAY = join(HERE, 'cordis.web.patch.yml');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const TIMEOUT_MS = Number(argValue('--timeout-ms', '900000'));
const SCRIPT = argValue('--script', '');
const OUT = resolve(argValue('--out', join(REPO, '.scratch', 'testing', 'browser-serve')));

// Refuse before creating evidence or starting the mock: this script boots the
// built plugin from lib/ and the web overlay serves client/. Never rebuild
// automatically — a stale build must be refreshed by the caller first.
try {
  assertBuildFresh('browser-serve');
} catch (error) {
  console.error(`[serve] ${error.message}`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const HOME = join(OUT, 'dsh-home');
mkdirSync(HOME, { recursive: true });

function timestampSlug() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

const children = [];

function killTree(pid) {
  if (pid === undefined) return;
  // Best-effort teardown: taskkill failures at shutdown are not actionable.
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

/** Parse `tasklist /FO CSV /NH` into `{ image, pid }` rows. */
function parseTasklistCsv(stdout) {
  return String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => {
      const fields = line.match(/"([^"]*)"/g);
      if (fields === null || fields.length < 2) return null;
      const image = fields[0].slice(1, -1).trim();
      const pid = fields[1].slice(1, -1).trim();
      if (image.length === 0 || !/^\d+$/.test(pid)) return null;
      return { image, pid: Number(pid) };
    })
    .filter((row) => row !== null);
}

/** One PID's `tasklist` CSV rows, or null when tasklist itself could not run. */
function tasklistFor(pid) {
  const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout;
}

/** Is the PID still the executable we launched? A recycled PID is not ours. */
function launchedProcessAlive(pid, expectedImage, tasklistCsv) {
  const wantPid = Number(pid);
  const wantImage = String(expectedImage ?? '').toLowerCase();
  return parseTasklistCsv(tasklistCsv).some((row) => {
    if (row.pid !== wantPid) return false;
    return wantImage === '' || row.image.toLowerCase() === wantImage;
  });
}

/**
 * Kill one launched child only while its PID still names our executable. A kill
 * timer can fire long after exit; Windows recycles PIDs, so an identity-less
 * `taskkill /T /F` could kill an innocent process. When tasklist cannot answer
 * we skip the kill rather than guess.
 */
function killIfOurs(entry) {
  if (entry.exited || entry.pid === undefined) return false;
  const csv = tasklistFor(entry.pid);
  if (csv === null) {
    console.log(`[serve] tasklist failed for ${entry.label} (pid ${entry.pid}); not killing`);
    return false;
  }
  if (!launchedProcessAlive(entry.pid, entry.image, csv)) {
    console.log(`[serve] pid ${entry.pid} is no longer ${entry.image}; not killing`);
    return false;
  }
  killTree(entry.pid);
  return true;
}

function launch(label, command, args, env) {
  const logPath = join(OUT, `${label}.log`);
  const stream = [];
  const child = spawn(command, args, {
    cwd: REPO,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk) => {
    const text = chunk.toString();
    stream.push(text);
    process.stdout.write(text);
    writeFileSync(logPath, stream.join(''), 'utf8');
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const entry = { label, child, pid: child.pid, image: basename(command), exited: false, timer: null };
  child.on('exit', () => {
    entry.exited = true;
    // Clear the timer on exit: it must never fire at a PID that has already
    // been released and possibly recycled.
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  });
  children.push(entry);
  // Kill timer armed AT LAUNCH (AGENTS.md), not only at teardown.
  entry.timer = setTimeout(() => {
    if (entry.exited) return;
    console.log(`[serve] kill timer fired for ${label} (pid ${entry.pid})`);
    shutdown(1);
  }, TIMEOUT_MS);
  entry.timer.unref?.();
  return entry;
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

function dshBin() {
  // Resolve through the same npm global root the harness uses.
  const out = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true, shell: true });
  const root = (out.stdout ?? '').trim();
  const pkg = join(root, '@deepseek-ai', 'dsh', 'package.json');
  if (!existsSync(pkg)) throw new Error(`dsh not found under npm global root: ${root}`);
  const manifest = JSON.parse(readFileSync(pkg, 'utf8'));
  return { bin: join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), version: manifest.version };
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const entry of children) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.exited) killIfOurs(entry);
  }
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Orphan watchdog: when the caller kills this process's shell (a background
// task stop, a closed terminal), Windows does not deliver SIGTERM here and
// the mock + dsh children keep their ports. Windows also does not reparent,
// so `process.ppid` keeps naming a dead PID — liveness must be probed.
const initialParent = process.ppid;
function parentGone() {
  if (process.ppid !== initialParent) return true;
  try {
    process.kill(initialParent, 0);
    return false;
  } catch {
    return true;
  }
}
const parentWatch = setInterval(() => {
  if (parentGone()) {
    console.log(`[serve] parent ${initialParent} gone; shutting down`);
    shutdown(0);
  }
}, 2000);
parentWatch.unref?.();


function parseWebUrl(text) {
  return /dsh web: (http:\/\/[^\s]+)/.exec(text)?.[1] ?? null;
}

/** Wait until `text()` matches, bounded. */
async function waitFor(label, text, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const value = text();
    if (value !== null && value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const port = await freePort();
const mock = launch('mock', process.execPath, [MOCK], {
  ...process.env,
  MOCK_PORT: String(port),
  MOCK_LOG: join(OUT, 'mock-requests.jsonl'),
  MOCK_SCRIPT: SCRIPT,
  MOCK_REPLY: 'Browser pass: the mock model answered.',
});

const mockLog = join(OUT, 'mock-requests.jsonl');
await waitFor('mock health', () => (existsSync(mockLog) ? 'ready' : null), 15000).catch(() => {});

const dsh = dshBin();
const web = launch(
  'dsh-web',
  process.execPath,
  [dsh.bin, '--profile', 'web', '--patch', OVERLAY, '--no-open'],
  {
    ...process.env,
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/v1`,
    DEEPSEEK_API_KEY: 'mock-key-not-a-secret',
    DSH_HOME: HOME,
    DSH_TELEMETRY_MODE: 'DISABLED',
  },
);

const webLog = join(OUT, 'dsh-web.log');
const webUrl = await waitFor(
  'dsh web url',
  () => (existsSync(webLog) ? parseWebUrl(readFileSync(webLog, 'utf8')) : null),
  120000,
).catch((error) => {
  console.error(`[serve] ${error.message}`);
  shutdown(1);
  return null;
});

if (webUrl !== null) {
  writeFileSync(join(OUT, 'url.txt'), `${webUrl}\n`, 'utf8');
  console.log('');
  console.log('  READY');
  console.log(`  url:   ${webUrl}`);
  console.log(`  out:   ${OUT}`);
  console.log(`  dsh:   ${dsh.version}`);
  console.log('  Ctrl+C (or the kill timer) tears everything down.');
  console.log('');
}
