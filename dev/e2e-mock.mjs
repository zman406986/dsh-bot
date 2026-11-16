// dev/e2e-mock.mjs — offline end-to-end harness: scripted model + real dsh process.
//
// Phases, reported separately so a blocker in one never masquerades as
// success in another:
//
//   mock      Protocol self-test against dev/mock-llm.mjs directly (no dsh):
//             fixed reply, tool-call reply, chunked streaming reply, error reply.
//   boot      Real `dsh --profile headless` against the mock with a THROWAWAY
//             DSH_HOME. Proves: mock serves the real provider protocol, dsh boots
//             with DEEPSEEK_BASE_URL, a task is sent, a scripted reply comes back.
//   dispatch  Real `dsh --profile web --patch dev/cordis.web.patch.yml`, a session
//             opened through the host's own RPC, /dsh-bot, one task, and a wait
//             for the dispatcher surface to offer the stock `subagent` tool.
//             Asserts the whole stock worker set is there
//             (subagent / list_agents / send_message / interrupt_agent) and
//             that the retired worker verbs are gone.
//             Runs only when the plugin actually mounts on the installed dsh.
//   s1..s4    The ticket-120 messaging / completion / mitosis / responsiveness
//             scenarios on the stock subagent surface. One boot each, plugin
//             loaded from SOURCE (`--import tsx` + dev/cordis.src.patch.yml)
//             because lib/ is a build artifact and this harness never builds.
//             Every assertion reads observable behaviour from the mock's request
//             log: what a tool RETURNED, what the next turn saw, and which turn
//             a message or the host's own `subagent-settled` notice arrived on.
//
// Every child gets a kill timer ARMED AT LAUNCH (taskkill /T /F on Windows).
// Every wait is bounded. Cleanup runs in `finally` and is verified with tasklist
// against the launched PID *and* image name, so a recycled PID cannot fake a leak.
//
// Usage:
//   node dev/e2e-mock.mjs [--out <dir>] [--timeout-ms <n>] [--skip <names>]
//                         [--only <names>] [--self-check]
//
// `--only s1,s4` runs just those phases; `--skip mock,boot,dispatch,s1` runs
// everything else. `--self-check` runs only the cleanup identity matcher's
// regression cases (no processes, no evidence) and exits. Exit code 0 means
// every selected phase passed: mock, boot, every scenario that ran, and the
// dispatch phase unless it is `blocked` (a real skip: a known host-side blocker
// stopped the turn, and no assertion failed). A dispatch `fail`, a failed
// assertion anywhere, a cleanup failure, or an escaped throw DOES gate the exit
// code; `blocked`, skipped, and unselected phases do not.
//
// The dispatch phase boots the built plugin from lib/; it refuses to start on
// a stale/missing build (dev/build-freshness.mjs) and never rebuilds.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { assertBuildFresh } from './build-freshness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const MOCK = join(HERE, 'mock-llm.mjs');
const OVERLAY = join(HERE, 'cordis.web.patch.yml');
// Ticket 120: the scenario phases load the plugin from SOURCE, so they exercise
// the current tree without a build (`lib/` is a git-ignored build artifact and
// this harness is not allowed to build).
const SRC_OVERLAY = join(HERE, 'cordis.src.patch.yml');
const DIAGNOSTICS_OVERLAY = join(HERE, 'e2e-diagnostics.patch.yml');

// ── arguments and evidence root ──────────────────────────────────────────────

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const RUN_TIMEOUT_MS = Number(argValue('--timeout-ms', '180000'));
const SKIP = new Set(argValue('--skip', '').split(',').filter(Boolean));
const ONLY = new Set(argValue('--only', '').split(',').filter(Boolean));
// `--self-check` exercises the cleanup identity matcher alone: no dsh, no mock,
// no evidence directory. It is the regression guard for the recycled-PID defect.
const SELF_CHECK = process.argv.includes('--self-check');
const OUT = resolve(
  argValue('--out', join(REPO, '.scratch', 'testing', '2026-10-18-mock-llm', timestampSlug())),
);

/** Filesystem-safe local timestamp. */
function timestampSlug() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// `--self-check` runs the cleanup identity matcher alone and exits: no dsh, no
// mock, no evidence directory, no process launch.
if (SELF_CHECK) {
  selfCheckProcessIdentity();
  process.exit(process.exitCode ?? 0);
}

mkdirSync(OUT, { recursive: true });
const HOME = join(OUT, 'dsh-home');
mkdirSync(HOME, { recursive: true });

const steps = [];
const evidence = {
  startedAt: new Date().toISOString(),
  out: OUT,
  node: process.version,
  dsh: null,
  phases: {},
  assertions: [],
  steps,
  processCheck: null,
  ok: false,
};

function record(kind, detail = {}) {
  const entry = { t: new Date().toISOString(), kind, ...detail };
  steps.push(entry);
  console.log(`[${entry.t}] ${kind}${detail.message ? `: ${detail.message}` : ''}`);
}

function assert(phase, name, condition, detail) {
  const passed = Boolean(condition);
  evidence.assertions.push({ phase, name, passed, ...(detail === undefined ? {} : { detail }) });
  console.log(`  ${passed ? 'PASS' : 'FAIL'} [${phase}] ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 240)}`}`);
  return passed;
}

// ── ports ────────────────────────────────────────────────────────────────────

/** Ask the OS for a free loopback port. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
}

// ── process control (Windows-first) ──────────────────────────────────────────

const children = [];

/** Kill a Windows process tree. No-op when the pid is already gone. */
function killTree(pid) {
  if (pid === undefined) return;
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  record('kill', {
    message: `taskkill /PID ${pid} /T /F -> ${result.status}`,
    status: result.status,
  });
}

/** Log a child's combined stdout/stderr into one file as it arrives. */
function pipeToFile(child, logPath) {
  const chunks = [];
  const push = (chunk) => {
    chunks.push(chunk);
    writeFileSync(logPath, Buffer.concat(chunks));
  };
  child.stdout?.on('data', push);
  child.stderr?.on('data', push);
}

// ── cleanup identity check (PID alone is not identity) ───────────────────────

/**
 * Parse `tasklist /FO CSV /NH` output into `{ image, pid }` rows. Header and
 * filter echoes, and the "no tasks match" notice, carry no quoted image+pid
 * pair and are dropped — so "no row" reliably means "not running".
 */
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

/**
 * Is the process we LAUNCHED still running? Requires the PID *and* the image
 * name captured at launch. Windows recycles PIDs: a former run saw `taskkill`
 * free 22628 and `backgroundTaskHost.exe` receive that same PID 35 s later, so
 * a PID-only match reported a leak that did not exist. A recycled PID owned by
 * a different executable is not our process — but when the expected image is
 * unknown we fall back to PID-only, so a real leak is still reported loudly.
 */
function launchedProcessAlive(pid, expectedImage, tasklistCsv) {
  const wantPid = Number(pid);
  const wantImage = String(expectedImage ?? '').toLowerCase();
  return parseTasklistCsv(tasklistCsv).some((row) => {
    if (row.pid !== wantPid) return false;
    return wantImage === '' || row.image.toLowerCase() === wantImage;
  });
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

/**
 * Kill a launched child only if its PID still names the executable we started.
 * A kill timer can fire long after the child exited; Windows recycles PIDs, and
 * `taskkill /T /F` on a recycled PID would kill an innocent process. When
 * tasklist cannot answer we skip the kill: the cleanup check reports the leak
 * loudly, while a wrong kill would be invisible.
 */
function killIfOurs(entry) {
  if (entry.exited || entry.pid === undefined) return false;
  const csv = tasklistFor(entry.pid);
  if (csv === null) {
    record('kill-skip', { message: `${entry.label} pid=${entry.pid}: tasklist failed; not killing`, pid: entry.pid });
    return false;
  }
  if (!launchedProcessAlive(entry.pid, entry.image, csv)) {
    record('kill-skip', { message: `${entry.label} pid=${entry.pid} is not our image; not killing`, pid: entry.pid });
    return false;
  }
  killTree(entry.pid);
  return true;
}

/** Regression guard for the cleanup matcher; run with `--self-check`. */
function selfCheckProcessIdentity() {
  const row = (image, pid) => `"${image}","${pid}","Console","1","10,000 K"`;
  const cases = [
    { name: 'empty tasklist output is not alive', actual: launchedProcessAlive(22628, 'node.exe', ''), expect: false },
    { name: 'the launched PID + image is alive', actual: launchedProcessAlive(22628, 'node.exe', row('node.exe', 22628)), expect: true },
    {
      name: 'a recycled PID owned by another image is not a leak',
      actual: launchedProcessAlive(22628, 'node.exe', row('backgroundTaskHost.exe', 22628)),
      expect: false,
    },
    { name: 'image name compares case-insensitively', actual: launchedProcessAlive(22628, 'node.exe', row('NODE.EXE', 22628)), expect: true },
    { name: 'a different PID is not alive', actual: launchedProcessAlive(22628, 'node.exe', row('node.exe', 12262)), expect: false },
    { name: 'the PID is a whole field, not a substring', actual: launchedProcessAlive(2262, 'node.exe', row('node.exe', 12262)), expect: false },
    {
      name: 'an unknown expected image falls back to PID-only (loud)',
      actual: launchedProcessAlive(22628, undefined, row('anything.exe', 22628)),
      expect: true,
    },
  ];
  const failed = cases.filter((entry) => entry.actual !== entry.expect);
  for (const entry of cases) {
    console.log(`  ${entry.actual === entry.expect ? 'PASS' : 'FAIL'} [self-check] ${entry.name}`);
  }
  console.log(`self-check: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${cases.length - failed.length}/${cases.length})`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

/**
 * Spawn a detached child, arm its hard kill timer IMMEDIATELY, and record the
 * handle. `timeoutMs` is the backstop, not the primary cleanup path.
 */
function launch(label, command, args, options, { timeoutMs = RUN_TIMEOUT_MS, logPath } = {}) {
  const child = spawn(command, args, {
    ...options,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const entry = {
    label,
    pid: child.pid,
    // Identity, not just the PID: Windows recycles PIDs, so cleanup must know
    // which executable this PID belonged to at launch.
    image: basename(command),
    command,
    args,
    startedAt: new Date().toISOString(),
    exited: false,
    exitCode: null,
    killTimerFired: false,
    timer: null,
  };
  children.push(entry);
  record('launch', { message: `${label} pid=${child.pid}`, pid: child.pid, timeoutMs });

  // Kill timer armed at launch, before any other work can fail.
  entry.timer = setTimeout(() => {
    entry.killTimerFired = true;
    record('kill-timer', { message: `${label} exceeded ${timeoutMs} ms; checking before killing`, pid: child.pid });
    killIfOurs(entry);
  }, timeoutMs);
  entry.timer.unref?.();

  if (logPath !== undefined) pipeToFile(child, logPath);
  child.once('exit', (code, signal) => {
    entry.exited = true;
    // Clear the timer on exit: it must never fire at a PID that has already
    // been released and possibly recycled.
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.exitCode = code;
    entry.signal = signal;
    record('exit', { message: `${label} pid=${child.pid} code=${code} signal=${signal}`, code, signal });
  });
  child.once('error', (error) => record('spawn-error', { message: `${label}: ${String(error)}` }));
  return entry;
}

/** Kill every started child (newest first) and clear its timer. */
function shutdownAll() {
  for (const entry of [...children].reverse()) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.exited) killIfOurs(entry);
  }
}

// Ctrl+C, a closed terminal, or a background-task stop must not leave the
// mock + dsh children holding ports. Windows does not deliver SIGTERM to a
// killed parent's children and does not reparent them, so the parent is
// probed for liveness (same watchdog as dev/browser-serve.mjs).
let interrupted = false;
function abortRun(signal) {
  if (interrupted) return;
  interrupted = true;
  record('interrupt', { message: `${signal}; killing every launched child` });
  shutdownAll();
  process.exit(signal === 'SIGINT' ? 130 : 143);
}
process.on('SIGINT', () => abortRun('SIGINT'));
process.on('SIGTERM', () => abortRun('SIGTERM'));

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
  if (!parentGone() || interrupted) return;
  interrupted = true;
  record('parent-gone', { message: `parent ${initialParent} gone; killing every launched child` });
  shutdownAll();
  process.exit(0);
}, 2000);
parentWatch.unref?.();

/**
 * Wait for a predicate with a deadline. `watch` children that already exited
 * are reported so a dead process cannot be polled forever — but the caller
 * decides whether an early exit is fatal (`allowExit`).
 */
async function waitFor(label, predicate, timeoutMs, { intervalMs = 250, watch = [], allowExit = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    for (const entry of watch) {
      if (entry.exited && !allowExit) {
        throw new Error(`${label}: ${entry.label} exited early with code ${entry.exitCode}`);
      }
    }
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}${lastError ? `: ${String(lastError)}` : ''}`);
}

// ── mock helpers ─────────────────────────────────────────────────────────────

/** Start the scripted model server; resolves with its base URL once healthy. */
async function startMock({ label = 'mock-llm', logPath, scriptFile, reply }) {
  const port = await freePort();
  const requestLog = logPath.replace(/\.log$/, '.jsonl');
  const entry = launch(
    label,
    process.execPath,
    [MOCK],
    {
      cwd: REPO,
      env: {
        ...process.env,
        MOCK_PORT: String(port),
        MOCK_LOG: requestLog,
        ...(scriptFile === undefined ? {} : { MOCK_SCRIPT: scriptFile }),
        ...(reply === undefined ? {} : { MOCK_REPLY: reply }),
      },
    },
    { logPath },
  );
  await waitFor(
    'mock health',
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      return response?.ok === true;
    },
    15000,
    { watch: [entry] },
  );
  return { entry, port, base: `http://127.0.0.1:${port}`, requestLog };
}

/** Read the mock's JSONL request log (empty until the first request). */
function readRequests(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** Minimal Anthropic-Messages SSE reader used by the mock self-test. */
async function callMock(base, body) {
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    return { status: response.status, body: await response.text(), text: '', tools: [], events: [] };
  }
  const raw = await response.text();
  const events = raw
    .split('\n\n')
    .map((frame) => /^data: (.+)$/m.exec(frame)?.[1])
    .filter(Boolean)
    .map((data) => JSON.parse(data));
  let text = '';
  const tools = [];
  let stop = null;
  let deltas = 0;
  for (const event of events) {
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      tools.push({ id: event.content_block.id, name: event.content_block.name });
    }
    if (event.type === 'content_block_start' && event.content_block?.type === 'text') deltas += 0;
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      text += event.delta.text;
      deltas += 1;
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
      tools.at(-1).input = JSON.parse(event.delta.partial_json);
    }
    if (event.type === 'message_delta') stop = event.delta?.stop_reason ?? null;
  }
  return { status: response.status, text, tools, stop, deltas, events };
}

// ── dsh helpers ──────────────────────────────────────────────────────────────

/** Absolute path of the global dsh install (its lib/bin.js runs without a shell). */
function globalDshRoot() {
  const fromEnv = process.env.DSH_INSTALL_ROOT;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const besideNode = join(dirname(process.execPath), 'node_modules');
  if (existsSync(join(besideNode, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) return besideNode;
  const result = spawnSync('npm root -g', { encoding: 'utf8', windowsHide: true, shell: true });
  const root = (result.stdout ?? '').trim();
  if (root.length > 0 && existsSync(join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) return root;
  throw new Error('cannot locate the global dsh install; set DSH_INSTALL_ROOT');
}

/** dsh's lib/bin.js path and version (read from its package.json — offline). */
function dshEntry() {
  const root = globalDshRoot();
  const manifest = JSON.parse(readFileSync(join(root, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
  return { bin: join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), version: manifest.version };
}

/** Environment that can only ever reach the mock. */
function mockOnlyEnv(mockBase, home) {
  return {
    ...process.env,
    // The one supported provider switch: @deepseek-ai/dsh-llm-deepseek resolves
    // its endpoint from $DEEPSEEK_BASE_URL, its key from the credential ref
    // DEEPSEEK_API_KEY. No other knob exists on 0.2.1.
    DEEPSEEK_BASE_URL: `${mockBase}/v1`,
    DEEPSEEK_API_KEY: 'mock-key-not-a-secret',
    DSH_HOME: home,
    DSH_TELEMETRY_MODE: 'DISABLED',
  };
}

/** Read the compressed JSONL session log for one session id ([] while absent). */
function readSessionEvents(home, sessionId) {
  const root = join(home, 'sessions');
  if (!existsSync(root)) return [];
  for (const workspace of readdirSync(root)) {
    const path = join(root, workspace, sessionId, 'session.v4.jsonl.zstd');
    if (!existsSync(path)) continue;
    let text;
    try {
      text = zstdDecompressSync(readFileSync(path)).toString('utf8');
    } catch {
      continue;
    }
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((event) => event !== null);
  }
  return [];
}

/** Exchange the launch token for an API cookie (one-time GET /connect). */
async function connect(webUrl) {
  const url = new URL(webUrl);
  const origin = `${url.protocol}//${url.host}`;
  const response = await fetch(`${origin}/connect?token=${url.searchParams.get('token')}&interactions=answer`, {
    redirect: 'manual',
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) throw new Error(`connect returned ${response.status} without a cookie`);
  return { origin, cookie: setCookie.split(';')[0] };
}

/** One Remote RPC call on the host's own /api channel. */
async function rpc(api, method, args) {
  const response = await fetch(`${api.origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: api.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text);
  if (parsed.result?.ok !== true) {
    throw new Error(`${method}: ${parsed.result?.error?.code ?? 'error'} ${parsed.result?.error?.message ?? ''}`);
  }
  return parsed.result.value;
}

/** Parse the tokenized boot URL that `dsh web` prints. */
function parseWebUrl(text) {
  return /dsh web: (http:\/\/[^\s]+)/.exec(text)?.[1] ?? null;
}

/** Run one commands/list through the API to see which commands the plugin registered. */
async function listCommands(api, sessionId) {
  try {
    return (await rpc(api, 'commands/list', { agentId: sessionId })).map((command) => command.name);
  } catch {
    return [];
  }
}

// ── phase: mock protocol self-test ───────────────────────────────────────────

async function phaseMock() {
  record('phase', { message: 'mock protocol self-test' });
  const scriptFile = join(OUT, 'mock-selftest-script.json');
  writeFileSync(
    scriptFile,
    JSON.stringify(
      [
        { match: { userIncludes: 'selftest-tool' }, say: 'calling a tool.', tool: { name: 'read', input: { file_path: 'x' } } },
        { match: { userIncludes: 'selftest-chunks' }, say: 'stream me in pieces', chunks: 4 },
        { match: { userIncludes: 'selftest-error' }, error: { status: 401, type: 'authentication_error', message: 'mock: rejected key' } },
      ],
      null,
      2,
    ),
  );
  const mock = await startMock({
    label: 'mock-selftest',
    logPath: join(OUT, 'mock-selftest.log'),
    scriptFile,
    reply: 'fixed self-test reply',
  });
  const result = { mock: mock.base };
  const base = { model: 'mock', stream: true, messages: [{ role: 'user', content: 'plain' }] };

  const fixed = await callMock(mock.base, base);
  result.fixed = { status: fixed.status, text: fixed.text, stop: fixed.stop };
  assert('mock', 'fixed reply returned as Anthropic SSE', fixed.status === 200 && fixed.text === 'fixed self-test reply' && fixed.stop === 'end_turn', result.fixed);

  const tooled = await callMock(mock.base, {
    ...base,
    messages: [{ role: 'user', content: 'selftest-tool' }],
    tools: [{ name: 'read', description: 'read a file', input_schema: { type: 'object' } }],
  });
  result.tool = { name: tooled.tools[0]?.name, input: tooled.tools[0]?.input, stop: tooled.stop };
  assert('mock', 'tool-call reply carries tool_use and stop_reason tool_use', tooled.tools[0]?.name === 'read' && tooled.stop === 'tool_use', result.tool);

  const chunked = await callMock(mock.base, { ...base, messages: [{ role: 'user', content: 'selftest-chunks' }] });
  result.chunks = { text: chunked.text, deltas: chunked.deltas };
  assert('mock', 'streaming reply split into multiple text_delta frames', chunked.text === 'stream me in pieces' && chunked.deltas >= 3, result.chunks);

  const failed = await callMock(mock.base, { ...base, messages: [{ role: 'user', content: 'selftest-error' }] });
  result.error = { status: failed.status, body: failed.body.slice(0, 160) };
  assert('mock', 'scripted error returns its HTTP status', failed.status === 401, result.error);

  const logged = readRequests(mock.requestLog);
  result.requests = logged.length;
  assert('mock', 'every request is logged to JSONL', logged.length === 4 && logged.every((entry) => entry.path === '/v1/messages'), { count: logged.length });

  evidence.phases.mock = { status: statusFrom('mock'), ...result };
  killIfOurs(mock.entry);
  // Await real exit, not a fixed delay: the cleanup check runs later and a
  // still-dying child would be reported as a leak.
  await waitFor('mock exit', () => Promise.resolve(mock.entry.exited), 10000, {
    watch: [mock.entry],
    allowExit: true,
  }).catch(() => {});
}

// ── phase: real dsh boot against the mock ────────────────────────────────────

async function phaseBoot() {
  record('phase', { message: 'real dsh headless boot against the mock' });
  const home = join(OUT, 'headless-home');
  mkdirSync(home, { recursive: true });
  const mock = await startMock({ label: 'mock-headless', logPath: join(OUT, 'mock-headless.log'), reply: 'scripted boot reply' });
  const dsh = launch(
    'dsh-headless',
    process.execPath,
    [dshEntry().bin, '--profile', 'headless', 'hello from the mock harness'],
    { cwd: REPO, env: mockOnlyEnv(mock.base, home) },
    { logPath: join(OUT, 'headless.log'), timeoutMs: 90000 },
  );
  let exit;
  try {
    exit = await waitFor('headless exit', () => (dsh.exited ? dsh : null), 90000, {
      watch: [dsh],
      allowExit: true,
    });
  } catch (error) {
    evidence.phases.boot = { status: 'fail', error: String(error) };
    throw error;
  }
  const stdout = readFileSync(join(OUT, 'headless.log'), 'utf8');
  const requests = readRequests(mock.requestLog);
  const first = requests.find((entry) => entry.toolNames?.length > 0) ?? requests[0];

  const result = {
    exitCode: exit.exitCode,
    stdoutTail: stdout.slice(-400),
    requests: requests.length,
    firstRequest: first === undefined ? null : { path: first.path, model: first.model, stream: first.stream, toolCount: first.toolNames.length, userText: first.lastUserText?.slice(0, 80) },
  };
  assert('boot', 'dsh headless exited 0', exit.exitCode === 0, { exitCode: exit.exitCode });
  assert('boot', 'the mock received the real provider request', requests.length >= 1 && first.path === '/v1/messages' && first.stream === true, result.firstRequest);
  assert('boot', 'the host offered its tool catalog to the mock', first.toolNames.length > 0, { toolCount: first.toolNames.length });
  assert('boot', 'scripted reply reached stdout', stdout.includes('scripted boot reply'), { stdoutTail: result.stdoutTail });

  evidence.phases.boot = { status: statusFrom('boot'), ...result };
  killIfOurs(mock.entry);
  await waitFor('mock exit', () => Promise.resolve(mock.entry.exited), 10000).catch(() => {});
}

// ── phase: dispatcher end to end (web + overlay) ─────────────────────────────

/**
 * Known 0.2.1 host-side errors that block the plugin from running a turn.
 * Both were observed in the same boot: apply throws before the dispatcher
 * tools exist, and the file-inbox policy message is also refused by the v4
 * session format. The first is the boot-level blocker.
 */
const KNOWN_BLOCKERS = [
  {
    needle: 'settings.register is not a function',
    why: 'plugin apply throws at boot: the 0.2.1 settings service exposes no register(ns, schema, {base})',
  },
  {
    needle: 'producer-owned source kind',
    why: 'plugin-authored user messages cannot persist: session format v4 refuses source kind "plugin"',
  },
];

/** Every known blocker whose text appears in a boot log. */
function blockersIn(log) {
  return KNOWN_BLOCKERS.filter((entry) => log.includes(entry.needle));
}

/** Reduce a boot log to the lines a human needs: host-log errors plus their cause. */
function diagnosticsFrom(log) {
  const lines = log.split('\n');
  const interesting = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/\[host-log .* (error|warn) /.test(line)) continue;
    interesting.push(line.slice(0, 500));
    // Attach the first stack frame of a following throw, if any.
    for (let next = index + 1; next < Math.min(index + 4, lines.length); next += 1) {
      if (/^\s+at /.test(lines[next]) && !lines[next].includes('node_modules')) {
        interesting.push(lines[next].slice(0, 300));
        break;
      }
    }
  }
  return interesting.slice(0, 24);
}

// The stock-subagent surface: workers start with the host's own `subagent`
// tool and are handled with the host's own control trio. The plugin adds only
// `deliver_result`, `message_agent` and `spawn_dispatcher`; the five retired
// worker verbs (ticket 120's generation) must not come back.
const STOCK_WORKER_TOOLS = ["subagent", "list_agents", "send_message", "interrupt_agent"];
const RETIRED_WORKER_TOOLS = ["spawn_worker", "check_workers", "steer_worker", "stop_worker", "await_agent"];

/** The retired worker verbs a request still offers (empty is the pass). */
function retiredToolsOffered(toolNames) {
  return RETIRED_WORKER_TOOLS.filter((name) => (toolNames ?? []).includes(name));
}

async function phaseDispatch(scriptFile) {
  record('phase', { message: 'dispatcher e2e (web profile + dev overlay)' });
  const home = join(OUT, 'web-home');
  mkdirSync(home, { recursive: true });
  const mock = await startMock({ label: 'mock-web', logPath: join(OUT, 'mock-web.log'), scriptFile, reply: 'mock fallback reply' });
  const bootLog = join(OUT, 'dsh-web.log');
  const dsh = launch(
    'dsh-web',
    process.execPath,
    [
      dshEntry().bin,
      '--profile',
      'web',
      '--patch',
      OVERLAY,
      // Harness-only: forwards the host logger to stderr so a failed turn is
      // diagnosable. Applied after the shipped overlay.
      '--patch',
      DIAGNOSTICS_OVERLAY,
      '--no-open',
      '--port',
      String(await freePort()),
    ],
    { cwd: REPO, env: mockOnlyEnv(mock.base, home) },
    { logPath: bootLog, timeoutMs: 120000 },
  );
  const phase = { status: 'fail', mock: mock.base };

  try {
    const webUrl = await waitFor(
      'dsh web boot line',
      () => (existsSync(bootLog) ? parseWebUrl(readFileSync(bootLog, 'utf8')) : null),
      90000,
      { watch: [dsh] },
    );
    phase.webUrl = webUrl.replace(/token=[^&]+/, 'token=<redacted>');
    record('booted', { message: phase.webUrl });

    const api = await connect(webUrl);
    const session = await rpc(api, 'session/create', { request: { cwd: REPO.replaceAll('\\', '/') } });
    const sessionId = session.sessionId;
    phase.sessionId = sessionId;

    const commands = await listCommands(api, sessionId);
    phase.commands = commands;
    assert('dispatch', 'plugin commands are registered', commands.includes('dsh-bot'), { count: commands.length });

    const activation = await rpc(api, 'commands/execute', {
      agentId: sessionId,
      line: '/dsh-bot',
      submittedAttachments: [],
    });
    phase.activation = activation?.result ?? null;
    assert('dispatch', '/dsh-bot reports success', activation?.result?.kind === 'success', phase.activation);

    // The GUI's own model picker issues this call; a fresh session has no
    // installed selection and a prompt without one drives no turn on 0.2.1.
    const selection = await rpc(api, 'session/selectModel', {
      request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash' },
    });
    phase.modelSelection = selection?.selected ?? null;

    await rpc(api, 'session/prompt', {
      request: {
        requestId: crypto.randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'mock-e2e-smoke' }],
      },
    });
    record('prompt', { message: 'task sent to the dispatcher' });

    const toolRequest = await waitFor(
      'a request that offers subagent',
      () => readRequests(mock.requestLog).find((entry) => entry.toolNames?.includes('subagent')) ?? null,
      60000,
      { watch: [dsh, mock.entry] },
    );
    const offered = toolRequest.toolNames ?? [];
    phase.spawnRequest = {
      toolCount: offered.length,
      userText: toolRequest.lastUserText?.slice(0, 120),
      stockWorkerTools: STOCK_WORKER_TOOLS.filter((name) => offered.includes(name)),
      retiredStillOffered: retiredToolsOffered(offered),
    };
    assert(
      'dispatch',
      'host sent the stock worker surface (subagent, list_agents, send_message, interrupt_agent) to the mock',
      STOCK_WORKER_TOOLS.every((name) => offered.includes(name)),
      phase.spawnRequest,
    );
    assert(
      'dispatch',
      'the retired worker verbs are gone from the dispatcher surface',
      phase.spawnRequest.retiredStillOffered.length === 0,
      { stillOffered: phase.spawnRequest.retiredStillOffered },
    );
    // Assert against full text: the truncated field can hold only the host's
    // injected policy, while the task still has to be in the conversation sent.
    const taskSeen =
      (toolRequest.lastUserFull ?? '').includes('mock-e2e-smoke') ||
      (toolRequest.userTextsAll ?? []).some((text) => text.includes('mock-e2e-smoke'));
    assert('dispatch', 'host sent the user task text', taskSeen);

    // The scripted spawn reply must be accepted, and the worker's turn must arrive.
    const workerRequest = await waitFor(
      'the worker turn at the mock',
      () =>
        readRequests(mock.requestLog).find((entry) =>
          (entry.systemFull ?? entry.systemTail ?? '').includes('delegated worker'),
        ) ?? null,
      60000,
      { watch: [dsh, mock.entry] },
    );
    phase.workerRequest = { userText: workerRequest.lastUserText?.slice(0, 120) };
    assert('dispatch', 'a spawned worker reached the mock', workerRequest !== null, phase.workerRequest);

    // The host writes session logs through a `session/flush` durability
    // checkpoint, so at kill time the on-disk log may hold only the header
    // ("session/flush" is the only flush entry point, dsh-session/lib/index.js
    // :1939-1956). Asserting on it would measure the flush cadence, not the
    // dispatcher. What proves the dispatcher actually ran is the model
    // conversation the host drove, which the mock records in full.
    const dispatcherRequests = readRequests(mock.requestLog).filter(
      (entry) => Array.isArray(entry.userTextsAll) && entry.userTextsAll.some((text) => text.includes('mock-e2e-smoke')),
    );
    phase.dispatcherRequests = dispatcherRequests.length;
    assert(
      'dispatch',
      'the dispatcher drove a turn carrying the user task',
      dispatcherRequests.length > 0,
      { requests: dispatcherRequests.length },
    );

    phase.status = statusFrom('dispatch');
  } catch (error) {
    const log = existsSync(bootLog) ? readFileSync(bootLog, 'utf8') : '';
    const blockers = blockersIn(log);
    phase.error = String(error?.message ?? error);
    phase.diagnostics = diagnosticsFrom(log);
    // `blocked` is a real skip: a known host-side blocker stopped the turn
    // before the plugin could run. It must never hide a failed assertion —
    // that is a product/harness failure and gates the exit code.
    const assertionFailed = assertionsFor('dispatch').some((entry) => !entry.passed);
    if (blockers.length > 0 && !assertionFailed) {
      phase.status = 'blocked';
      // The first blocker is the one that stops boot; report all observed.
      phase.blockedBy = blockers[0].why;
      phase.knownBlockers = blockers.map((entry) => entry.why);
    } else {
      phase.status = 'fail';
    }
  } finally {
    killIfOurs(dsh);
    killIfOurs(mock.entry);
  }

  if (phase.status === 'blocked') {
    console.log(`  BLOCKED [dispatch] ${phase.blockedBy}`);
  }
  evidence.phases.dispatch = phase;
}

/** Assertions made while a phase runs; the phase status is derived from these. */
function assertionsFor(phase) {
  return evidence.assertions.filter((entry) => entry.phase === phase);
}

/** `pass` only when at least one assertion ran and every one of them passed. */
function statusFrom(phase) {
  const ran = assertionsFor(phase);
  if (ran.length === 0) return 'fail';
  return ran.every((entry) => entry.passed) ? 'pass' : 'fail';
}

// ── ticket 120: messaging / await / mitosis scenarios ────────────────────────
//
// Every scenario boots ONE real dsh web process against the mock, activates a
// dispatcher through the host's own RPC (`/dsh-bot`), and then drives it with a
// script whose steps are matched against what the conversation actually
// contains. Assertions read the mock's request log: a tool's returned body,
// what the next request saw, and which request (turn) carried it. Nothing
// asserts on plugin-internal counters, and nothing calls plugin internals.

/** Start one mock + one real dsh web, plugin loaded from the named overlay. */
async function bootRuntime({ label, scriptFile, reply, overlay, tsx }) {
  const home = join(OUT, `${label}-home`);
  mkdirSync(home, { recursive: true });
  const mock = await startMock({
    label: `mock-${label}`,
    logPath: join(OUT, `${label}-mock.log`),
    scriptFile,
    reply,
  });
  const bootLog = join(OUT, `${label}-dsh.log`);
  const args = [
    // `--import tsx` only for the source overlay: dsh runs TS modules with
    // their `.ts` specifiers preserved, so Node needs a loader.
    ...(tsx ? ['--import', 'tsx'] : []),
    dshEntry().bin,
    '--profile',
    'web',
    '--patch',
    overlay,
    // Harness-only: forwards the host logger to stderr so a failed turn is
    // diagnosable. Applied after the plugin overlay.
    '--patch',
    DIAGNOSTICS_OVERLAY,
    '--no-open',
    '--port',
    String(await freePort()),
  ];
  const dsh = launch(`dsh-${label}`, process.execPath, args, { cwd: REPO, env: mockOnlyEnv(mock.base, home) }, { logPath: bootLog, timeoutMs: RUN_TIMEOUT_MS });
  return { mock, dsh, bootLog };
}

/** Open a chat, activate the dispatcher in it, and pick the mock model. */
async function openDispatcher(bootLog, dsh) {
  const webUrl = await waitFor(
    'dsh web boot line',
    () => (existsSync(bootLog) ? parseWebUrl(readFileSync(bootLog, 'utf8')) : null),
    90000,
    { watch: [dsh] },
  );
  const api = await connect(webUrl);
  const session = await rpc(api, 'session/create', { request: { cwd: REPO.replaceAll('\\', '/') } });
  const sessionId = session.sessionId;
  await rpc(api, 'commands/execute', { agentId: sessionId, line: '/dsh-bot', submittedAttachments: [] });
  // The GUI's own model picker issues this call; a fresh session has no
  // installed selection and a prompt without one drives no turn on 0.2.1.
  await rpc(api, 'session/selectModel', {
    request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash' },
  });
  return { api, sessionId, webUrl };
}

/** Send one real user message (the host records it with source.kind "user"). */
async function sendUserMessage(api, sessionId, text) {
  return rpc(api, 'session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    },
  });
}

/** Requests the mock served for one session id, in arrival order. */
function sessionRequests(mock, sessionId) {
  return readRequests(mock.requestLog).filter((entry) => entry.sessionId === sessionId);
}

/** Every request the mock served, in arrival order (all sessions). */
function allRequests(mock) {
  return readRequests(mock.requestLog);
}

/** Wait for ANY request (any session) that satisfies a predicate. */
function waitForAnyRequest(mock, label, predicate, timeoutMs, watch) {
  return waitFor(
    label,
    () => allRequests(mock).find(predicate) ?? null,
    timeoutMs,
    { watch, intervalMs: 250 },
  );
}

/** What one tool RETURNED in a request (model-facing bodies), by tool name. */
function toolResultTexts(entry, toolName) {
  return (entry.toolResults ?? []).filter((result) => result.tool === toolName).map((result) => result.text);
}

/** Wait for a request on a session that satisfies a predicate. */
function waitForRequest(mock, sessionId, label, predicate, timeoutMs, watch) {
  return waitFor(
    label,
    () => sessionRequests(mock, sessionId).find(predicate) ?? null,
    timeoutMs,
    { watch, intervalMs: 250 },
  );
}

/**
 * Wait for the request that CARRIES a tool's returned body. The request that
 * issued the call and the request that carries its result are different
 * model turns; a scenario must read the latter.
 */
function waitForToolResult(mock, sessionId, toolName, label, timeoutMs, watch, extra = () => true) {
  return waitForRequest(
    mock,
    sessionId,
    label,
    (entry) => toolResultTexts(entry, toolName).length > 0 && extra(entry),
    timeoutMs,
    watch,
  );
}

/**
 * The stock `subagent` tool's model-facing result. Its output schema is
 * `{kind:"activation", subagentId}` and its render is
 * `started subagent <id>` (dsh-tool-subagent/lib/index.js:409-429), so the
 * activation id is readable from the tool-result body the model saw. That id
 * IS the child session id and the address `send_message` takes.
 */
const SUBAGENT_STARTED_PATTERN = /started subagent ([^\s]+)/;

/** The activation id out of a stock `subagent` result, or null. */
function subagentActivationId(text) {
  return SUBAGENT_STARTED_PATTERN.exec(text ?? '')?.[1] ?? null;
}

/**
 * The host's own completion notice for a settled subagent
 * (dsh-subagent/lib/types/continuation-messages.js:91-116): one user-role
 * message (source kind `subagent-settled`) opening with
 * `Background subagent <id> finished and will do no further work unless you
 * send it more.`, then `Its closing message:` and the child's closing text.
 * It is the parent's result — there is no wait tool to call and no status poll.
 */
function settlementNoticeFor(userTexts, childId) {
  return (userTexts ?? []).find((text) => text.includes(`Background subagent ${childId} `)) ?? null;
}

const SCENARIO_TIMEOUT_MS = 120000;

/**
 * Ticket 120 scenario 1 — a dispatcher messages a RUNNING worker and the
 * worker's next step reflects the correction (the steer path end to end,
 * including the step-boundary send). Rebuilt on the stock subagent surface:
 * the worker starts with `subagent`, the correction is `send_message`, and
 * the parent's result is the host's own `subagent-settled` notice.
 *
 * Observable assertions:
 * - `subagent` returned the stock activation id ("started subagent <id>");
 * - `send_message` returned "message delivered to agent <id>";
 * - a LATER worker turn at the mock carries the exact correction text — the
 *   worker's next step saw it (no `[Parent correction]` wrapper: stock
 *   `send_message` injects the raw text as the steer);
 * - the worker finished on the corrected instruction;
 * - the parent's later turn carries the stock completion notice with the
 *   worker's closing message.
 */
async function scenario1() {
  record('phase', { message: 's1 — message a running worker (stock send_message steer)' });
  const scriptFile = join(OUT, 's1-script.json');
  writeFileSync(
    scriptFile,
    JSON.stringify(
      [
        {
          // The dispatcher's first move: start a worker through the stock tool.
          match: { anyUserIncludes: 's1-start', toolNames: ['subagent'] },
          say: 's1-spawn',
          tool: {
            name: 'subagent',
            input: { description: 'S1 draftsman', prompt: 's1-worker-brief: produce a draft.' },
          },
        },
        {
          // The worker's FIRST step is slow on purpose: it must still be
          // running when the correction is sent.
          match: { systemIncludes: 'delegated worker', anyUserIncludes: 's1-worker-brief' },
          say: 'worker-draft-v1',
          delayMs: 20000,
        },
        {
          // The dispatcher's continuation after the spawn ack. The delay puts
          // the steer well inside the worker's first step, so "the worker is
          // running" is not a race in this scenario.
          match: { toolResultIncludes: 'started subagent', toolNames: ['send_message'] },
          say: 's1-steer',
          delayMs: 6000,
          capture: { workerId: ['started subagent ([^\\s]+)'] },
          tool: {
            name: 'send_message',
            input: { agent_id: '{{workerId}}', message: 's1-correction-marker: use the other format instead.' },
          },
        },
        {
          // The worker's NEXT step is opened by the step-boundary steer.
          match: { systemIncludes: 'delegated worker', anyUserIncludes: 's1-correction-marker' },
          say: 'worker-final-v2',
        },
        {
          // The host's completion notice starts the parent's next turn.
          match: { anyUserIncludes: 'worker-final-v2', toolNames: ['subagent'] },
          say: 's1-dispatcher-done',
        },
      ],
      null,
      2,
    ),
  );

  const { mock, dsh, bootLog } = await bootRuntime({ label: 's1', scriptFile, reply: 's1-fallback', overlay: SRC_OVERLAY, tsx: true });
  const phase = { status: 'fail', scenario: 's1', mock: mock.base };
  try {
    const { api, sessionId } = await openDispatcher(bootLog, dsh);
    phase.sessionId = sessionId;
    await sendUserMessage(api, sessionId, 's1-start');

    // Read the RESULT from the request that carries the tool_result, not from
    // the request that issued the call (they are different model turns).
    const spawnResultRequest = await waitForToolResult(
      mock,
      sessionId,
      'subagent',
      'the subagent result to reach the model',
      SCENARIO_TIMEOUT_MS,
      [dsh, mock.entry],
    );
    const spawnResult = toolResultTexts(spawnResultRequest, 'subagent').at(-1) ?? '';
    phase.spawnResult = spawnResult.slice(0, 240);
    const workerId = subagentActivationId(spawnResult);
    phase.workerId = workerId;
    assert('s1', 'subagent returned the stock activation id (started subagent <id>)', workerId !== null, { returned: phase.spawnResult });
    if (workerId === null) throw new Error(`subagent returned no activation id: ${spawnResult.slice(0, 200)}`);

    const sendResultRequest = await waitForToolResult(
      mock,
      sessionId,
      'send_message',
      'the send_message result to reach the model',
      SCENARIO_TIMEOUT_MS,
      [dsh, mock.entry],
    );
    const sendResult = toolResultTexts(sendResultRequest, 'send_message').at(-1) ?? '';
    phase.sendResult = sendResult.slice(0, 240);
    assert(
      's1',
      'send_message delivered the correction to the running worker',
      sendResult.includes(`message delivered to agent ${workerId}`),
      { returned: phase.sendResult },
    );

    // The correction lands on the WORKER's session, so the search must span
    // every session: filtering by the dispatcher's id here made the predicate
    // unsatisfiable (no request is both the dispatcher session and a worker
    // turn). That bug was masked while s1 failed earlier, at the steer ack.
    const corrected = await waitForAnyRequest(
      mock,
      'the worker turn that saw the correction',
      (entry) =>
        (entry.systemFull ?? '').includes('delegated worker') &&
        (entry.userTextsAll ?? []).some((text) => text.includes('s1-correction-marker')) &&
        (entry.userTextsAll ?? []).some((text) => text.includes('use the other format instead.')),
      // Bounded well below the scenario budget: when the send is refused the
      // correction can never arrive, and a long wait would only hide that.
      30000,
      [dsh, mock.entry],
    ).catch(() => null);
    phase.correctionSeenAtMock = corrected !== null;
    assert('s1', 'the worker\'s NEXT step carries the exact correction text', corrected !== null);

    const workerTurns = allRequests(mock).filter((entry) => (entry.systemFull ?? '').includes('delegated worker'));
    phase.workerTurns = workerTurns.length;
    // Compare by the log's own identity field, not by object reference:
    // `waitForAnyRequest` and `workerTurns` are two separate JSONL parses, so
    // `indexOf(object)` could never match.
    const correctedSeq = corrected === null ? null : corrected.seq;
    const correctedIndex =
      correctedSeq === null
        ? -1
        : workerTurns.findIndex((entry) => entry.seq === correctedSeq);
    phase.correctedWorkerTurnIndex = correctedIndex;
    assert(
      's1',
      'the correction was folded into a later worker turn, not a restart',
      corrected !== null && correctedIndex > 0,
      { workerTurns: phase.workerTurns, correctedIndex },
    );

    const finalWorkerTurn = readRequests(mock.requestLog).find((entry) => (entry.reply?.say ?? '').includes('worker-final-v2')) ?? null;
    assert('s1', 'the worker finished on the corrected instruction', finalWorkerTurn !== null);

    // The parent's result is the host's own settlement notice: it must arrive
    // on a LATER dispatcher turn and carry the child's closing text.
    const noticeTurn = await waitForRequest(
      mock,
      sessionId,
      'the stock completion notice to reach the parent',
      (entry) => settlementNoticeFor(entry.userTextsAll, workerId) !== null,
      SCENARIO_TIMEOUT_MS,
      [dsh, mock.entry],
    ).catch(() => null);
    const noticeText = noticeTurn === null ? null : settlementNoticeFor(noticeTurn.userTextsAll, workerId);
    phase.notice = noticeText === null ? null : noticeText.slice(0, 400);
    phase.noticeTurnSeq = noticeTurn?.seq ?? null;
    assert('s1', 'the parent got the stock subagent-settled notice for that child', noticeText !== null, { notice: phase.notice });
    assert(
      's1',
      'the notice carries "Its closing message:" and the worker\'s closing answer',
      noticeText !== null && noticeText.includes('Its closing message:') && noticeText.includes('worker-final-v2'),
      { notice: phase.notice },
    );
    assert(
      's1',
      'the notice opened a later parent turn and the dispatcher continued',
      noticeTurn !== null && noticeTurn.seq > spawnResultRequest.seq && (noticeTurn.reply?.say ?? '').includes('s1-dispatcher-done'),
      { spawnSeq: spawnResultRequest.seq, noticeSeq: noticeTurn?.seq ?? null, reply: (noticeTurn?.reply?.say ?? '').slice(0, 80) },
    );

    phase.status = statusFrom(phase.scenario);
  } catch (error) {
    phase.error = String(error?.message ?? error);
    const log = existsSync(bootLog) ? readFileSync(bootLog, 'utf8') : '';
    phase.diagnostics = diagnosticsFrom(log);
  } finally {
    killIfOurs(dsh);
    killIfOurs(mock.entry);
  }
  evidence.phases.s1 = phase;
  return phase;
}

/**
 * Ticket 120 scenario 2 — a dispatcher starts a slow worker, ENDS its turn,
 * and receives the result as the host's own completion notice on a fresh turn.
 *
 * Ticket 117 retired the bounded wait, and the stock-subagent refactor removed
 * its last name: there is no `await_agent`, and no stock tool blocks on a
 * child. This phase therefore asserts the stock behaviour that replaces it —
 * push, not poll — and proves the wait cannot be silently faked:
 *
 * Observable assertions:
 * - the dispatcher surface offers `subagent` and the stock control trio and
 *   NO wait verb (`await_agent` / `check_workers`);
 * - the parent's turn carrying the spawn result ended instead of polling;
 * - nothing else on the dispatcher session ran before the notice;
 * - the notice names the finished child and carries "Its closing message:"
 *   plus the worker's report marker;
 * - the notice opened a LATER parent turn and the scripted continuation
 *   (`s2-notice-received`) is that turn's reply.
 */
async function scenario2() {
  record('phase', { message: 's2 — the stock completion notice is the result, on a new turn' });
  const scriptFile = join(OUT, 's2-script.json');
  writeFileSync(
    scriptFile,
    JSON.stringify(
      [
        {
          match: { anyUserIncludes: 's2-start', toolNames: ['subagent'] },
          say: 's2-spawn',
          tool: {
            name: 'subagent',
            input: { description: 'S2 slow worker', prompt: 's2-worker-brief: take a moment, then report.' },
          },
        },
        {
          // The worker's only turn is slow on purpose: the parent is idle
          // again well before the notice, so the notice has to OPEN a turn.
          match: { systemIncludes: 'delegated worker', anyUserIncludes: 's2-worker-brief' },
          say: 's2-worker-result-marker',
          delayMs: 4000,
        },
        {
          // The parent's turn that carries the spawn result: the dispatcher
          // ends it. No wait tool is called — there is none to call.
          match: { toolResultIncludes: 'started subagent', toolNames: ['subagent'] },
          say: 's2-no-wait',
        },
        {
          // The completion notice opens the parent's next turn.
          match: { anyUserIncludes: 's2-worker-result-marker', toolNames: ['subagent'] },
          say: 's2-notice-received',
        },
      ],
      null,
      2,
    ),
  );

  const { mock, dsh, bootLog } = await bootRuntime({ label: 's2', scriptFile, reply: 's2-fallback', overlay: SRC_OVERLAY, tsx: true });
  const phase = { status: 'fail', scenario: 's2', mock: mock.base };
  try {
    const { api, sessionId } = await openDispatcher(bootLog, dsh);
    phase.sessionId = sessionId;
    await sendUserMessage(api, sessionId, 's2-start');

    const spawnResultRequest = await waitForToolResult(
      mock,
      sessionId,
      'subagent',
      'the subagent result to reach the model',
      SCENARIO_TIMEOUT_MS,
      [dsh, mock.entry],
    );
    const spawnResult = toolResultTexts(spawnResultRequest, 'subagent').at(-1) ?? '';
    phase.spawnResult = spawnResult.slice(0, 240);
    const workerId = subagentActivationId(spawnResult);
    phase.workerId = workerId;
    assert('s2', 'subagent returned the stock activation id (started subagent <id>)', workerId !== null, { returned: phase.spawnResult });
    if (workerId === null) throw new Error(`subagent returned no activation id: ${spawnResult.slice(0, 200)}`);

    // No wait verb exists on the shipped surface: proven, not assumed.
    const offered = spawnResultRequest.toolNames ?? [];
    phase.offeredTools = offered;
    assert(
      's2',
      'the dispatcher surface has no wait verb to call',
      !offered.includes('await_agent') && !offered.includes('check_workers'),
      { retiredStillOffered: retiredToolsOffered(offered) },
    );
    assert(
      's2',
      'the dispatcher ended its turn on the spawn result instead of polling',
      (spawnResultRequest.reply?.say ?? '').includes('s2-no-wait'),
      { reply: (spawnResultRequest.reply?.say ?? '').slice(0, 120) },
    );

    const noticeTurn = await waitForRequest(
      mock,
      sessionId,
      'the stock completion notice to open a new turn',
      (entry) => settlementNoticeFor(entry.userTextsAll, workerId) !== null,
      SCENARIO_TIMEOUT_MS,
      [dsh, mock.entry],
    );
    const noticeText = settlementNoticeFor(noticeTurn.userTextsAll, workerId);
    phase.notice = noticeText.slice(0, 400);
    phase.noticeTurnSeq = noticeTurn.seq;
    assert(
      's2',
      'the notice names the finished child and its stop reason',
      noticeText.includes(`Background subagent ${workerId} finished`),
      { notice: phase.notice },
    );
    assert(
      's2',
      'the notice carries "Its closing message:" and the worker\'s report',
      noticeText.includes('Its closing message:') && noticeText.includes('s2-worker-result-marker'),
      { notice: phase.notice },
    );
    assert(
      's2',
      'the notice arrived on a LATER parent turn than the spawn result',
      noticeTurn.seq > spawnResultRequest.seq,
      { spawnSeq: spawnResultRequest.seq, noticeSeq: noticeTurn.seq },
    );
    // Push, not poll: nothing on the dispatcher session ran between the
    // spawn-result turn and the notice. The session-title request carries no
    // dispatcher surface, so the stock-tool filter excludes it by construction.
    const dispatcherTurnsBetween = sessionRequests(mock, sessionId).filter(
      (entry) =>
        entry.seq > spawnResultRequest.seq &&
        entry.seq < noticeTurn.seq &&
        (entry.toolNames ?? []).includes('subagent'),
    );
    phase.interveningDispatcherRequests = dispatcherTurnsBetween.length;
    assert(
      's2',
      'no dispatcher turn polled in between — the notice did the waking',
      dispatcherTurnsBetween.length === 0,
      { between: dispatcherTurnsBetween.map((entry) => entry.seq) },
    );
    assert(
      's2',
      'the parent turn after the notice continued (the notice is the result)',
      (noticeTurn.reply?.say ?? '').includes('s2-notice-received'),
      { reply: (noticeTurn.reply?.say ?? '').slice(0, 120) },
    );

    phase.status = statusFrom(phase.scenario);
  } catch (error) {
    phase.error = String(error?.message ?? error);
    const log = existsSync(bootLog) ? readFileSync(bootLog, 'utf8') : '';
    phase.diagnostics = diagnosticsFrom(log);
  } finally {
    killIfOurs(dsh);
    killIfOurs(mock.entry);
  }
  evidence.phases.s2 = phase;
  return phase;
}

// Ticket 297: the spawn_dispatcher ack names the child dispatcher in prose.
// Commit afe9846 retired `as a peer dispatcher (session <id>)` in favour of
// `message_agent addressed to <id>`; this harness kept parsing only the old
// shape, so s3 read childId === null and six assertions cascaded. Accept both
// shapes so the harness tolerates either copy, and neither rewording silently
// rots the id again.
const CHILD_ID_PATTERNS = [
  /as a peer dispatcher \(session ([^)\s]+)\)/,
  /message_agent addressed to ([^\s;,.)]+)/,
];

/** The child dispatcher's session id from a spawn_dispatcher ack, or null. */
function spawnAckChildId(ack) {
  for (const pattern of CHILD_ID_PATTERNS) {
    const id = pattern.exec(ack ?? '')?.[1];
    if (id !== undefined && id !== '') return id;
  }
  return null;
}

/**
 * Ticket 120 scenario 3 — a dispatcher spawns a CHILD DISPATCHER; the child
 * spawns a worker; the child's result arrives at the creator as a peer message
 * on a later turn.
 *
 * The child addresses its creator by the session id from its OWN peer roster
 * (`## Other agents — not the user`), which is how a real model would learn it.
 * Observable assertions:
 * - `spawn_dispatcher` returned a dispatcher id and the "peer dispatcher" note;
 * - the child session is a real dispatcher on the STOCK surface (its own
 *   `subagent` + `list_agents`, none of the retired worker verbs, and NO
 *   `spawn_dispatcher` — ticket 176 withholds the summon verb from the spawned
 *   class) and its brief reached it;
 * - the child spawned a worker with `subagent` and that worker ran;
 * - a LATER creator turn carries the peer-message heading and the child's text;
 * - the child's send was accepted for the creator's session.
 */
async function scenario3() {
  record('phase', { message: 's3 — spawn_dispatcher child reports back as a peer message' });
  const scriptFile = join(OUT, 's3-script.json');
  writeFileSync(
    scriptFile,
    JSON.stringify(
      [
        {
          match: { anyUserIncludes: 's3-start', toolNames: ['spawn_dispatcher'] },
          say: 's3-summon',
          tool: {
            name: 'spawn_dispatcher',
            input: { title: 'Mitosis child', prompt: 's3-child-brief: own the slice and report back.' },
          },
        },
        {
          match: { toolResultIncludes: 'as a peer dispatcher' },
          say: 's3-creator-ack',
        },
        {
          // The child dispatcher's first turn: its brief is its only unique text.
          // Ticket 297 / 176: a summoned dispatcher is still a dispatcher, but
          // `spawn_dispatcher` is deliberately withheld from its surface, so the
          // gate must use the surface it DOES have. Gating on `spawn_dispatcher`
          // made this step unmatchable, so the child never spawned its worker.
          // Stock-subagent refactor: that surface is `subagent` + `list_agents`,
          // and the worker starts with the stock `subagent` tool.
          match: { anyUserIncludes: 's3-child-brief', toolNames: ['subagent', 'list_agents'] },
          say: 's3-child-spawn',
          tool: {
            name: 'subagent',
            input: { description: 'S3 child worker', prompt: 's3-worker-brief: produce the slice.' },
          },
        },
        {
          match: { systemIncludes: 'delegated worker', anyUserIncludes: 's3-worker-brief' },
          say: 's3-worker-result-marker',
        },
        {
          // The child's settle wake for its worker. It answers its creator,
          // addressed by the creator's id from the child's own peer roster.
          match: { anyUserIncludes: 's3-worker-result-marker', toolNames: ['message_agent'] },
          say: 's3-child-message',
          capture: {
            creatorId: ['## Other agents — not the user[\\s\\S]{0,800}?(session-[0-9a-f-]{20,})'],
          },
          tool: {
            name: 'message_agent',
            input: { target: '{{creatorId}}', text: 's3-child-report: the slice is done — s3-worker-result-marker.' },
          },
        },
        {
          match: { toolResultIncludes: 'Accepted for peer session' },
          say: 's3-child-done',
        },
        {
          match: { anyUserIncludes: 's3-child-report' },
          say: 's3-creator-got-report',
        },
      ],
      null,
      2,
    ),
  );

  const { mock, dsh, bootLog } = await bootRuntime({ label: 's3', scriptFile, reply: 's3-fallback', overlay: SRC_OVERLAY, tsx: true });
  const phase = { status: 'fail', scenario: 's3', mock: mock.base };
  try {
    const { api, sessionId: creatorId } = await openDispatcher(bootLog, dsh);
    phase.creatorId = creatorId;
    await sendUserMessage(api, creatorId, 's3-start');

    // The ACK lives in the request that CARRIES the tool result (seq 3), not
    // in the request that issued the call (seq 1).
    const summonResultRequest = await waitForToolResult(
      mock,
      creatorId,
      'spawn_dispatcher',
      'the spawn_dispatcher result to reach the model',
      SCENARIO_TIMEOUT_MS,
      [dsh, mock.entry],
    );
    const summonAck = toolResultTexts(summonResultRequest, 'spawn_dispatcher').at(-1) ?? '';
    phase.summonAck = summonAck.slice(0, 300);
    // Ticket 297: the ack is prose, and the id's position moved in afe9846
    // (`(session <id>)` -> `message_agent addressed to <id>`). Both the phrase
    // and an extractable id are still required — the check is not relaxed.
    assert(
      's3',
      'spawn_dispatcher returned a peer dispatcher id',
      summonAck.includes('as a peer dispatcher') && spawnAckChildId(summonAck) !== null,
      { returned: phase.summonAck },
    );

    // The id comes from whichever shipped ack shape is present (ticket 297).
    const childId = spawnAckChildId(summonAck);
    phase.childId = childId;
    assert('s3', 'the returned child id is a session id', childId !== null, { childId });

    const childRequest = childId === null ? null : await waitForRequest(
      mock,
      childId,
      'the child dispatcher\'s first turn',
      (entry) => (entry.userTextsAll ?? []).some((text) => text.includes('s3-child-brief')),
      SCENARIO_TIMEOUT_MS,
      [dsh, mock.entry],
    ).catch(() => null);
    const childToolNames = childRequest?.toolNames ?? [];
    phase.childToolCount = childToolNames.length;
    // Ticket 176: the spawned class is a dispatcher (own workers, ledger, inbox,
    // team-leader policy) whose surface withholds `spawn_dispatcher`, so it
    // cannot summon further dispatchers. Both halves are asserted: the stock
    // dispatcher verbs it must carry, and the verb it must not.
    phase.childRetiredTools = retiredToolsOffered(childToolNames);
    assert(
      's3',
      'the child is a dispatcher on the stock surface (subagent and list_agents, no retired worker verbs)',
      childRequest !== null &&
        childToolNames.includes('subagent') &&
        childToolNames.includes('list_agents') &&
        phase.childRetiredTools.length === 0,
      { toolCount: phase.childToolCount, retiredStillOffered: phase.childRetiredTools },
    );
    assert(
      's3',
      'the child cannot summon further dispatchers — its surface has no spawn_dispatcher (ticket 176)',
      childRequest !== null && !childToolNames.includes('spawn_dispatcher'),
      { hasSpawnDispatcher: childToolNames.includes('spawn_dispatcher'), toolCount: phase.childToolCount },
    );
    assert(
      's3',
      'the child received its brief (it does not see the creator conversation)',
      childRequest !== null && (childRequest.userTextsAll ?? []).some((text) => text.includes('s3-child-brief')),
    );

    // The child's spawn ack lands before its worker's first request; wait for
    // the worker turn rather than reading the log once (a single read can race
    // the mock's append).
    const workerRequest = await waitFor(
      'the child\'s worker to reach the mock',
      () =>
        readRequests(mock.requestLog).find(
          (entry) =>
            (entry.systemFull ?? '').includes('delegated worker') &&
            (entry.userTextsAll ?? []).some((text) => text.includes('s3-worker-brief')),
        ) ?? null,
      30000,
      { watch: [dsh, mock.entry] },
    ).catch(() => null);
    assert('s3', 'the child spawned a worker and it ran', workerRequest !== null);

    const childSendResultRequest = childId === null ? null : await waitForToolResult(
      mock,
      childId,
      'message_agent',
      'the child\'s message_agent result to reach the model',
      SCENARIO_TIMEOUT_MS,
      [dsh, mock.entry],
    ).catch(() => null);
    const childSendResult =
      childSendResultRequest === null ? '' : toolResultTexts(childSendResultRequest, 'message_agent').at(-1) ?? '';
    phase.childSendResult = childSendResult.slice(0, 240);
    assert(
      's3',
      'the child addressed its creator by the roster session id and the send was accepted',
      childSendResult.includes(`Accepted for peer session ${creatorId}`),
      { returned: phase.childSendResult },
    );

    const peerTurn = await waitForRequest(
      mock,
      creatorId,
      'the peer message to reach the creator on a later turn',
      (entry) =>
        (entry.userTextsAll ?? []).some((text) => text.includes('s3-child-report')) &&
        (entry.userTextsAll ?? []).some((text) => text.includes('Peer message — not from the user')),
      SCENARIO_TIMEOUT_MS,
      [dsh, mock.entry],
    );
    phase.peerTurnSeq = peerTurn.seq;
    phase.summonSeq = summonResultRequest.seq;
    assert(
      's3',
      'the child\'s report arrived on a LATER turn as a peer message (not as the user)',
      peerTurn.seq > summonResultRequest.seq,
      { summonSeq: summonResultRequest.seq, peerSeq: peerTurn.seq },
    );

    phase.status = statusFrom(phase.scenario);
  } catch (error) {
    phase.error = String(error?.message ?? error);
    const log = existsSync(bootLog) ? readFileSync(bootLog, 'utf8') : '';
    phase.diagnostics = diagnosticsFrom(log);
  } finally {
    killIfOurs(dsh);
    killIfOurs(mock.entry);
  }
  evidence.phases.s3 = phase;
  return phase;
}

/**
 * Ticket 120 scenario 4 — a real USER message while a worker is RUNNING: the
 * dispatcher answers it on its own turn, and the worker's result still arrives
 * later (PRD S1 responsiveness). Retargeted by the stock-subagent refactor.
 *
 * The old phase proved that a user message released an in-turn `await_agent`.
 * That premise is gone — ticket 117 retired the wait, the stock surface has no
 * wait verb, and nothing blocks a dispatcher turn on a child. What remains
 * provable offline is the S1 property the wait was protecting: the dispatcher
 * is responsive while a worker runs, and the worker's own result is neither
 * stolen nor lost. So the phase now sends the same real user message (through
 * the host's own `session/prompt` RPC, exactly as the GUI composer does) while
 * the worker is mid-step, and asserts that:
 *
 * - the dispatcher surface has no in-turn wait tool, and its spawn turn ended;
 * - the user message opened a new dispatcher turn and was answered;
 * - the worker's completion notice arrived only after its scripted 25 s step,
 *   i.e. the user turn neither stopped nor answered for the worker;
 * - the notice carries the worker's own closing answer, and the dispatcher
 *   continued on that later turn.
 */
async function scenario4() {
  record('phase', { message: 's4 — the dispatcher stays responsive while a worker runs (PRD S1)' });
  const scriptFile = join(OUT, 's4-script.json');
  writeFileSync(
    scriptFile,
    JSON.stringify(
      [
        {
          match: { anyUserIncludes: 's4-start', toolNames: ['subagent'] },
          say: 's4-spawn',
          tool: {
            name: 'subagent',
            input: { description: 'S4 slow worker', prompt: 's4-worker-brief: finish much later.' },
          },
        },
        {
          match: { systemIncludes: 'delegated worker', anyUserIncludes: 's4-worker-brief' },
          say: 's4-worker-late-result',
          delayMs: 25000,
        },
        {
          // The parent's arrival turn ends; there is nothing to wait on.
          match: { toolResultIncludes: 'started subagent', toolNames: ['subagent'] },
          say: 's4-turn-ended',
        },
        {
          // The user's own message, delivered while the worker is still
          // inside its 25 s step.
          match: { anyUserIncludes: 's4-user-message' },
          say: 's4-answered-the-user',
        },
        {
          // The worker's completion notice opens a turn of its own.
          match: { anyUserIncludes: 's4-worker-late-result', toolNames: ['subagent'] },
          say: 's4-late-result-arrived',
        },
      ],
      null,
      2,
    ),
  );

  const { mock, dsh, bootLog } = await bootRuntime({ label: 's4', scriptFile, reply: 's4-fallback', overlay: SRC_OVERLAY, tsx: true });
  const phase = { status: 'fail', scenario: 's4', mock: mock.base };
  try {
    const { api, sessionId } = await openDispatcher(bootLog, dsh);
    phase.sessionId = sessionId;
    await sendUserMessage(api, sessionId, 's4-start');

    const spawnResultRequest = await waitForToolResult(
      mock,
      sessionId,
      'subagent',
      'the subagent result to reach the model',
      SCENARIO_TIMEOUT_MS,
      [dsh, mock.entry],
    );
    const spawnResult = toolResultTexts(spawnResultRequest, 'subagent').at(-1) ?? '';
    phase.spawnResult = spawnResult.slice(0, 240);
    const workerId = subagentActivationId(spawnResult);
    phase.workerId = workerId;
    assert('s4', 'subagent returned the stock activation id (started subagent <id>)', workerId !== null, { returned: phase.spawnResult });
    if (workerId === null) throw new Error(`subagent returned no activation id: ${spawnResult.slice(0, 200)}`);

    const offered = spawnResultRequest.toolNames ?? [];
    assert(
      's4',
      'the dispatcher surface has no in-turn wait tool to block on',
      !offered.includes('await_agent') && !offered.includes('check_workers'),
      { retiredStillOffered: retiredToolsOffered(offered) },
    );
    assert(
      's4',
      'the dispatcher ended its spawn turn without waiting',
      (spawnResultRequest.reply?.say ?? '').includes('s4-turn-ended'),
      { reply: (spawnResultRequest.reply?.say ?? '').slice(0, 120) },
    );

    // The real user message, exactly as the GUI composer sends it — now while
    // the worker is mid-step, with no in-turn wait to release.
    record('prompt', { message: 's4: real user message while the worker runs' });
    await sendUserMessage(api, sessionId, 's4-user-message: status while the worker runs?');

    const userTurn = await waitForRequest(
      mock,
      sessionId,
      'the dispatcher to answer the user message while the worker runs',
      (entry) => (entry.userTextsAll ?? []).some((text) => text.includes('s4-user-message')),
      30000,
      [dsh, mock.entry],
    );
    phase.userTurnAt = userTurn.t;
    assert(
      's4',
      'the dispatcher answered the user on its own turn while the worker ran',
      (userTurn.reply?.say ?? '').includes('s4-answered-the-user'),
      { reply: (userTurn.reply?.say ?? '').slice(0, 120) },
    );

    // The worker was neither stopped nor answered for by the user turn: the
    // host's completion notice still arrives, later, with its closing answer.
    const noticeTurn = await waitForRequest(
      mock,
      sessionId,
      'the worker\'s completion notice after the user turn',
      (entry) => settlementNoticeFor(entry.userTextsAll, workerId) !== null,
      60000,
      [dsh, mock.entry],
    ).catch(() => null);
    const noticeText = noticeTurn === null ? null : settlementNoticeFor(noticeTurn.userTextsAll, workerId);
    phase.notice = noticeText === null ? null : noticeText.slice(0, 400);
    const noticeAfterUserMs = noticeTurn === null ? null : Date.parse(noticeTurn.t) - Date.parse(userTurn.t);
    phase.noticeAfterUserMs = noticeAfterUserMs;
    assert(
      's4',
      'the notice arrived only after the worker\'s scripted 25 s step — the user turn did not end it',
      noticeAfterUserMs !== null && noticeAfterUserMs >= 15000,
      { noticeAfterUserMs, workerDelayMs: 25000 },
    );
    assert(
      's4',
      'the notice carries the worker\'s own closing answer ("Its closing message:")',
      noticeText !== null && noticeText.includes('Its closing message:') && noticeText.includes('s4-worker-late-result'),
      { notice: phase.notice },
    );
    assert(
      's4',
      'the dispatcher continued on the notice turn',
      noticeTurn !== null && (noticeTurn.reply?.say ?? '').includes('s4-late-result-arrived'),
      { reply: (noticeTurn?.reply?.say ?? '').slice(0, 120) },
    );

    phase.status = statusFrom(phase.scenario);
  } catch (error) {
    phase.error = String(error?.message ?? error);
    const log = existsSync(bootLog) ? readFileSync(bootLog, 'utf8') : '';
    phase.diagnostics = diagnosticsFrom(log);
  } finally {
    killIfOurs(dsh);
    killIfOurs(mock.entry);
  }
  evidence.phases.s4 = phase;
  return phase;
}

const SCENARIOS = {
  s1: scenario1,
  s2: scenario2,
  s3: scenario3,
  s4: scenario4,
};

// ── main ─────────────────────────────────────────────────────────────────────

function writeDispatcherScript(path) {
  writeFileSync(
    path,
    JSON.stringify(
      [
        {
          match: { toolNames: ['subagent'], userIncludes: 'mock-e2e-smoke' },
          say: 'Starting one worker.',
          tool: {
            name: 'subagent',
            input: { description: 'Mock smoke worker', prompt: 'Reply with exactly: worker-ok' },
          },
        },
        { match: { systemIncludes: 'delegated worker' }, say: 'worker-ok' },
      ],
      null,
      2,
    ),
  );
}

/** Whether a phase name should run: `--only` narrows, `--skip` subtracts. */
function shouldRun(name) {
  if (ONLY.size > 0) return ONLY.has(name);
  return !SKIP.has(name);
}

let failure;
try {
  const dsh = dshEntry();
  evidence.dsh = dsh.version;
  record('start', { message: `dsh ${dsh.version}; evidence in ${OUT}` });

  if (!existsSync(OVERLAY)) throw new Error(`missing ${OVERLAY}`);

  if (shouldRun('mock')) {
    // Pre-mark every selected phase `fail`: a phase that throws before it can
    // record its own verdict must never read as unselected (non-gating).
    evidence.phases.mock = { status: 'fail' };
    await phaseMock();
  }
  if (shouldRun('boot')) {
    evidence.phases.boot = { status: 'fail' };
    await phaseBoot();
  }
  if (shouldRun('dispatch')) {
    // The dispatch phase is the only one that loads the built plugin. Refuse a
    // stale/missing lib/ or client/ instead of silently measuring an old build.
    // The name is marked `fail` before any check, so a selected-but-broken
    // dispatch can never read as skipped.
    evidence.phases.dispatch = { status: 'fail' };
    try {
      assertBuildFresh('dispatch phase');
      const scriptFile = join(OUT, 'script.json');
      writeDispatcherScript(scriptFile);
      await phaseDispatch(scriptFile);
    } catch (error) {
      evidence.phases.dispatch.error = String(error?.message ?? error);
      throw error;
    }
  }
  for (const [name, run] of Object.entries(SCENARIOS)) {
    if (!shouldRun(name)) continue;
    evidence.phases[name] = { status: 'fail' };
    if (!existsSync(SRC_OVERLAY)) throw new Error(`missing ${SRC_OVERLAY}`);
    await run();
  }
} catch (error) {
  failure = error;
  record('error', { message: String(error?.stack ?? error) });
} finally {
  shutdownAll();
  // Bounded per-child exit wait instead of one fixed sleep: a child that exits
  // promptly is not penalised, a stuck one has a deadline, and the cleanup
  // identity check never runs against a half-dead tree.
  for (const entry of children) {
    if (entry.pid === undefined) continue;
    await waitFor(`exit of ${entry.label}`, () => Promise.resolve(entry.exited), 5000, {
      allowExit: true,
    }).catch(() => {});
  }

  const alive = [];
  const tasklistFailures = [];
  for (const entry of children) {
    if (entry.pid === undefined) continue;
    const check = spawnSync('tasklist', ['/FI', `PID eq ${entry.pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    // A failed or blocked tasklist is NOT "no leak": it means the check could
    // not answer, so cleanup fails loudly instead of passing blind.
    if (check.error !== undefined || check.status !== 0) {
      tasklistFailures.push({
        label: entry.label,
        pid: entry.pid,
        error: String(check.error?.message ?? `tasklist exit ${check.status}`),
      });
      continue;
    }
    // Identity, not PID alone: Windows recycles PIDs, so a recycled PID now
    // owned by another executable is not our leak (see launchedProcessAlive).
    if (launchedProcessAlive(entry.pid, entry.image, check.stdout)) {
      alive.push({ label: entry.label, pid: entry.pid, expectedImage: entry.image });
    }
  }
  evidence.processCheck = {
    launched: children.map(({ label, pid, image }) => ({ label, pid, image })),
    aliveAfterCleanup: alive,
    tasklistFailures,
  };
  assert('cleanup', 'every process the harness launched is dead', alive.length === 0, alive);
  assert('cleanup', 'tasklist answered for every launched process', tasklistFailures.length === 0, tasklistFailures);

  // A phase that was not selected contributes nothing — neither pass nor fail.
  const cleanupFailed = evidence.assertions.some((entry) => entry.phase === 'cleanup' && !entry.passed);
  const harnessOk =
    (evidence.phases.mock === undefined || evidence.phases.mock.status === 'pass') &&
    (evidence.phases.boot === undefined || evidence.phases.boot.status === 'pass') &&
    alive.length === 0 &&
    tasklistFailures.length === 0 &&
    !cleanupFailed;
  const dispatchStatus = evidence.phases.dispatch?.status ?? 'skipped';
  // Ticket 120: every scenario that RAN must pass. A phase that was not
  // selected is `undefined`, which must not read as a failure.
  const scenarioStatuses = Object.fromEntries(
    Object.keys(SCENARIOS)
      .filter((name) => evidence.phases[name] !== undefined)
      .map((name) => [name, evidence.phases[name].status]),
  );
  const scenariosOk = Object.values(scenarioStatuses).every((status) => status === 'pass');
  // The dispatch phase's `blocked` verdict means a known host-side blocker
  // stopped the turn before the plugin could run (a real skip, and
  // phaseDispatch only assigns it when no assertion failed); it is reported
  // separately and does not gate. A `fail` is a harness/product failure and does.
  const dispatchOk = dispatchStatus !== 'fail';
  // A throw that escaped a selected phase is a failure even when that phase's
  // own verdict could not be recorded: `failure` must gate the exit code.
  evidence.ok = failure === undefined && harnessOk && dispatchOk && scenariosOk;
  evidence.dispatchStatus = dispatchStatus;
  evidence.scenarioStatuses = scenarioStatuses;
  evidence.finishedAt = new Date().toISOString();

  writeFileSync(join(OUT, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log('');
  console.log(`harness: ${harnessOk ? 'PASS' : 'FAIL'} (mock + real dsh boot + cleanup)`);
  console.log(`dispatcher e2e: ${dispatchStatus}${evidence.phases.dispatch?.blockedBy ? ` — blocked: ${evidence.phases.dispatch.blockedBy}` : ''}`);
  const ran = Object.entries(scenarioStatuses);
  if (ran.length > 0) {
    console.log(`scenarios: ${ran.map(([name, status]) => `${name}=${status}`).join(' ')}`);
  } else {
    console.log('scenarios: (none selected)');
  }
  console.log(`evidence: ${join(OUT, 'result.json')}`);
  if (failure !== undefined) console.error(failure.message);
  process.exitCode = evidence.ok ? 0 : 1;
}
