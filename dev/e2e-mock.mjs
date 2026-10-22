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
//             opened through the host's own RPC, /dsh-bot, one task, and
//             a wait for the dispatcher tools (spawn_worker) to reach the mock.
//             Runs only when the plugin actually mounts on the installed dsh.
//   s1..s4    The ticket-120 messaging / await / mitosis scenarios. One boot
//             each, plugin loaded from SOURCE (`--import tsx` +
//             dev/cordis.src.patch.yml) because lib/ is a build artifact and
//             this harness never builds. Every assertion reads observable
//             behaviour from the mock's request log: what a tool RETURNED,
//             what the next turn saw, and which turn a message arrived on.
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
// every phase that ran passed and every process the harness launched is dead. The dispatcher smoke phase keeps its
// separate `pass` / `blocked` / `fail` verdict and does not gate the exit code
// (as before); the scenario phases DO gate it.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

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
    record('kill-timer', { message: `${label} exceeded ${timeoutMs} ms; killing tree`, pid: child.pid });
    killTree(child.pid);
  }, timeoutMs);
  entry.timer.unref?.();

  if (logPath !== undefined) pipeToFile(child, logPath);
  child.once('exit', (code, signal) => {
    entry.exited = true;
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
    if (entry.timer !== null) clearTimeout(entry.timer);
    if (!entry.exited) killTree(entry.pid);
  }
}

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

  evidence.phases.mock = { status: 'pass', ...result };
  killTree(mock.entry.pid);
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

  evidence.phases.boot = { status: 'pass', ...result };
  killTree(mock.entry.pid);
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
      'a request that offers spawn_worker',
      () => readRequests(mock.requestLog).find((entry) => entry.toolNames?.includes('spawn_worker')) ?? null,
      60000,
      { watch: [dsh, mock.entry] },
    );
    phase.spawnRequest = { toolCount: toolRequest.toolNames.length, userText: toolRequest.lastUserText?.slice(0, 120) };
    assert('dispatch', 'host sent dispatcher tools (spawn_worker) to the mock', true, phase.spawnRequest);
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

    phase.status = 'pass';
  } catch (error) {
    const log = existsSync(bootLog) ? readFileSync(bootLog, 'utf8') : '';
    const blockers = blockersIn(log);
    phase.error = String(error?.message ?? error);
    phase.diagnostics = diagnosticsFrom(log);
    if (blockers.length > 0) {
      phase.status = 'blocked';
      // The first blocker is the one that stops boot; report all observed.
      phase.blockedBy = blockers[0].why;
      phase.knownBlockers = blockers.map((entry) => entry.why);
    }
  } finally {
    killTree(dsh.pid);
    killTree(mock.entry.pid);
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

/**
 * User messages the model can actually READ: non-empty text blocks only.
 *
 * The host delivers every tool_result as a user-role message with no text
 * block, so counting raw user messages would count tool steps. Kept as a
 * recorded fact for future scenarios: it is NOT a valid "same turn" proxy
 * either, because the host's own `subagent-settled` notice is an extra
 * user-role message WITH text inside one turn (ticket 120 s2, observed 1 → 2).
 */
function readableUserTexts(entry) {
  return (entry.userTextsAll ?? []).filter((text) => text.trim().length > 0);
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

const SCENARIO_TIMEOUT_MS = 120000;

/**
 * Ticket 120 scenario 1 — dispatcher messages a RUNNING worker; the worker's
 * next step reflects the correction (the steer path end to end, including the
 * step-boundary send).
 *
 * Observable assertions:
 * - the `message_agent` tool returned the steer ack ("Message parked for …");
 * - a LATER worker turn at the mock carries `[Parent correction]` and the exact
 *   correction text — i.e. the worker's next step saw it;
 * - the worker's turn that saw the correction is a different turn from the one
 *   the correction was parked against (the step-boundary send, not a restart).
 */
async function scenario1() {
  record('phase', { message: 's1 — message a running worker (steer end to end)' });
  const scriptFile = join(OUT, 's1-script.json');
  writeFileSync(
    scriptFile,
    JSON.stringify(
      [
        {
          // The dispatcher's first move: start a worker that takes a while.
          match: { anyUserIncludes: 's1-start', toolNames: ['spawn_worker'] },
          say: 's1-spawn',
          tool: {
            name: 'spawn_worker',
            input: {
              stream_key: 's1-stream',
              title: 'S1 draftsman',
              prompt: 's1-worker-brief: produce a draft.',
            },
          },
        },
        {
          // The worker's FIRST step is slow on purpose: it must still be
          // running when the correction is parked.
          match: { systemIncludes: 'delegated worker', anyUserIncludes: 's1-worker-brief' },
          say: 'worker-draft-v1',
          delayMs: 20000,
        },
        {
          // The dispatcher's continuation after the spawn ack. The delay puts
          // the steer well inside the worker's first step, so "the worker is
          // running" is not a race in this scenario.
          match: { toolResultIncludes: 'in the background (worker', toolNames: ['message_agent'] },
          say: 's1-steer',
          delayMs: 6000,
          capture: { workerId: ['in the background \\(worker ([^,\\s]+), stream '] },
          tool: {
            name: 'message_agent',
            input: { target: '{{workerId}}', text: 's1-correction-marker: use the other format instead.' },
          },
        },
        {
          // The worker's NEXT step is opened by the step-boundary send.
          match: { systemIncludes: 'delegated worker', anyUserIncludes: 's1-correction-marker' },
          say: 'worker-final-v2',
        },
        {
          match: { anyUserIncludes: 'worker-final-v2', toolNames: ['check_workers'] },
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

    // Read the ACK from the request that carries the tool result, not from the
    // request that issued the call (they are different model turns).
    const steerResultRequest = await waitForToolResult(
      mock,
      sessionId,
      'message_agent',
      'the message_agent result to reach the model',
      SCENARIO_TIMEOUT_MS,
      [dsh, mock.entry],
    );
    const steerResult = toolResultTexts(steerResultRequest, 'message_agent').at(-1) ?? '';
    phase.steerAck = steerResult.slice(0, 240);
    const steerAccepted = steerResult.includes('Message parked for "S1 draftsman"');
    assert('s1', 'message_agent returned the steer ack (correction parked)', steerAccepted, { returned: phase.steerAck });
    if (!steerAccepted) {
      // FIXED in ticket 120 (2026-10-22): the worker is registered before the
      // child can emit its first `agent/status: running`, so the FSM leaves
      // `spawned` and this lane accepts the steer. The branch is kept as a
      // diagnostic: if it ever fires again, the failure is the old race or a
      // new one in the same seam, and the assertions below stay real.
      phase.blocker = 'steer refused: worker status never left "spawned" (regressed?)';
    }

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
        (entry.userTextsAll ?? []).some((text) => text.includes('[Parent correction]')),
      // Bounded well below the scenario budget: when the steer is refused the
      // correction can never arrive, and a long wait would only hide that.
      30000,
      [dsh, mock.entry],
    ).catch(() => null);
    phase.correctionSeenAtMock = corrected !== null;
    assert('s1', 'the worker\'s NEXT step carries [Parent correction] and the exact text', corrected !== null);

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
    phase.status = statusFrom(phase.scenario);
  } catch (error) {
    phase.error = String(error?.message ?? error);
    const log = existsSync(bootLog) ? readFileSync(bootLog, 'utf8') : '';
    phase.diagnostics = diagnosticsFrom(log);
  } finally {
    killTree(dsh.pid);
    killTree(mock.entry.pid);
  }
  evidence.phases.s1 = phase;
  return phase;
}

/**
 * Ticket 120 scenario 2 — a dispatcher `await_agent`s a slow worker and
 * receives its result IN THE SAME TURN.
 *
 * Observable assertions:
 * - the `await_agent` tool returned `settled` with the worker's report text;
 * - the request that carried that result has the SAME number of user messages
 *   as the request that issued the call — no new turn opened in between;
 * - the worker's report marker is that result.
 */
async function scenario2() {
  record('phase', { message: 's2 — await_agent returns the result in the same turn' });
  const scriptFile = join(OUT, 's2-script.json');
  writeFileSync(
    scriptFile,
    JSON.stringify(
      [
        {
          match: { anyUserIncludes: 's2-start', toolNames: ['spawn_worker'] },
          say: 's2-spawn',
          tool: {
            name: 'spawn_worker',
            input: {
              stream_key: 's2-stream',
              title: 'S2 slow worker',
              prompt: 's2-worker-brief: take a moment, then report.',
            },
          },
        },
        {
          match: { systemIncludes: 'delegated worker', anyUserIncludes: 's2-worker-brief' },
          say: 's2-worker-result-marker',
          delayMs: 4000,
        },
        {
          match: { toolResultIncludes: 'in the background (worker', toolNames: ['await_agent'] },
          say: 's2-awaiting',
          capture: { workerId: ['in the background \\(worker ([^,\\s]+), stream '] },
          tool: { name: 'await_agent', input: { target: '{{workerId}}', timeout_ms: 60000 } },
        },
        {
          match: { toolResultIncludes: 'settled: completed' },
          say: 's2-await-done',
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

    const awaitCall = await waitForRequest(
      mock,
      sessionId,
      'the dispatcher to call await_agent',
      (entry) => entry.reply?.tool?.name === 'await_agent',
      SCENARIO_TIMEOUT_MS,
      [dsh, mock.entry],
    );
    const awaitResultRequest = await waitForRequest(
      mock,
      sessionId,
      'the await_agent result to reach the model',
      (entry) => toolResultTexts(entry, 'await_agent').length > 0,
      SCENARIO_TIMEOUT_MS,
      [dsh, mock.entry],
    );
    const awaitResult = toolResultTexts(awaitResultRequest, 'await_agent').at(-1) ?? '';
    phase.awaitResult = awaitResult.slice(0, 400);
    assert('s2', 'await_agent returned the settled worker', awaitResult.includes('settled: completed'), { returned: phase.awaitResult });
    assert('s2', 'the returned result IS the worker\'s report', awaitResult.includes('s2-worker-result-marker'));

    const userMessagesAtCall = readableUserTexts(awaitCall).length;
    const userMessagesAtResult = readableUserTexts(awaitResultRequest).length;
    phase.userMessages = { atCall: userMessagesAtCall, atResult: userMessagesAtResult };
    // "Same turn" is asserted by what the TOOL RETURNED (the settled result
    // above) plus the absence of any intervening dispatcher request: if the
    // wait had timed out, the tool would have answered `still-running` and the
    // report would only arrive later on a wake turn. Counting user messages is
    // NOT a valid proxy — the host delivers its own `subagent-settled` notice
    // as an extra user-role message inside the SAME turn (observed: 1 → 2).
    // Identify requests by `seq` (stable across log reads) and by SERVICE SESSION:
    // an intervening dispatcher turn would show up as a dispatcher-session
    // request between the call and the result.
    const between = sessionRequests(mock, sessionId).filter(
      (entry) => entry.seq > awaitCall.seq && entry.seq < awaitResultRequest.seq,
    );
    phase.interveningDispatcherRequests = between.length;
    assert(
      's2',
      'the tool call itself returned it — no intervening dispatcher request',
      awaitResultRequest.seq === awaitCall.seq + 1 || between.length === 0,
      { callSeq: awaitCall.seq, resultSeq: awaitResultRequest.seq, between: between.length },
    );
    assert(
      's2',
      'the dispatcher continued that turn after the result',
      awaitResultRequest.seq > awaitCall.seq && (awaitResultRequest.reply?.say ?? '').includes('s2-await-done'),
      { callSeq: awaitCall.seq, resultSeq: awaitResultRequest.seq },
    );

    phase.status = statusFrom(phase.scenario);
  } catch (error) {
    phase.error = String(error?.message ?? error);
    const log = existsSync(bootLog) ? readFileSync(bootLog, 'utf8') : '';
    phase.diagnostics = diagnosticsFrom(log);
  } finally {
    killTree(dsh.pid);
    killTree(mock.entry.pid);
  }
  evidence.phases.s2 = phase;
  return phase;
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
 * - the child session is a real dispatcher (spawn_dispatcher + await_agent on
 *   its tool surface) and its brief reached it;
 * - the child spawned a worker and that worker ran;
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
          match: { anyUserIncludes: 's3-child-brief', toolNames: ['spawn_dispatcher'] },
          say: 's3-child-spawn',
          tool: {
            name: 'spawn_worker',
            input: { stream_key: 's3-stream', title: 'S3 child worker', prompt: 's3-worker-brief: produce the slice.' },
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
    assert('s3', 'spawn_dispatcher returned a peer dispatcher id', /as a peer dispatcher \(session [^)]+\)/.test(summonAck), { returned: phase.summonAck });

    // The ack names the child as `(session <id>)`; the id is a bare uuid.
    const childId = /as a peer dispatcher \(session ([^)\s]+)\)/.exec(summonAck)?.[1] ?? null;
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
    phase.childToolCount = childRequest?.toolNames?.length ?? 0;
    assert(
      's3',
      'the child is a dispatcher (its own surface offers spawn_dispatcher and await_agent)',
      childRequest !== null &&
        (childRequest.toolNames ?? []).includes('spawn_dispatcher') &&
        (childRequest.toolNames ?? []).includes('await_agent'),
      { toolCount: phase.childToolCount },
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
    killTree(dsh.pid);
    killTree(mock.entry.pid);
  }
  evidence.phases.s3 = phase;
  return phase;
}

/**
 * Ticket 120 scenario 4 — a real USER message during `await_agent` releases
 * the wait promptly (PRD S1).
 *
 * The user message is sent through the host's own `session/prompt` RPC, so it
 * carries `source.kind: "user"` exactly as the GUI's composer does. Nothing
 * calls `releaseWaits` directly: the assertion is that the shipped trigger —
 * host `session/event` → plugin release — actually fires.
 *
 * Observable assertions:
 * - the `await_agent` tool returned `released` with the USER-MESSAGE copy
 *   ("was released because the user said something"), not the stopped copy;
 * - it returned well before the worker settled and far below the 120 s cap;
 * - the dispatcher produced a reply in that same turn;
 * - the worker kept running and its result still arrived later.
 */
async function scenario4() {
  record('phase', { message: 's4 — a user message releases the await (PRD S1)' });
  const scriptFile = join(OUT, 's4-script.json');
  writeFileSync(
    scriptFile,
    JSON.stringify(
      [
        {
          match: { anyUserIncludes: 's4-start', toolNames: ['spawn_worker'] },
          say: 's4-spawn',
          tool: {
            name: 'spawn_worker',
            input: {
              stream_key: 's4-stream',
              title: 'S4 slow worker',
              prompt: 's4-worker-brief: finish much later.',
            },
          },
        },
        {
          match: { systemIncludes: 'delegated worker', anyUserIncludes: 's4-worker-brief' },
          say: 's4-worker-late-result',
          delayMs: 25000,
        },
        {
          match: { toolResultIncludes: 'in the background (worker', toolNames: ['await_agent'] },
          say: 's4-awaiting',
          capture: { workerId: ['in the background \\(worker ([^,\\s]+), stream '] },
          tool: { name: 'await_agent', input: { target: '{{workerId}}', timeout_ms: 120000 } },
        },
        {
          match: { toolResultIncludes: 'was released because the user said something' },
          say: 's4-reply-after-release',
        },
        {
          match: { anyUserIncludes: 's4-user-interrupt' },
          say: 's4-answered-the-user',
        },
        {
          match: { anyUserIncludes: 's4-worker-late-result', toolNames: ['check_workers'] },
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

    const awaitCall = await waitForRequest(
      mock,
      sessionId,
      'the dispatcher to enter await_agent',
      (entry) => entry.reply?.tool?.name === 'await_agent',
      SCENARIO_TIMEOUT_MS,
      [dsh, mock.entry],
    );
    phase.awaitStartedAt = awaitCall.t;

    // The real user message, exactly as the GUI composer sends it.
    record('prompt', { message: 's4: user message during the await' });
    await sendUserMessage(api, sessionId, 's4-user-interrupt: stop waiting and answer me.');

    const releasedRequest = await waitForRequest(
      mock,
      sessionId,
      'the released await result to reach the model',
      (entry) => toolResultTexts(entry, 'await_agent').length > 0,
      30000,
      [dsh, mock.entry],
    );
    const released = toolResultTexts(releasedRequest, 'await_agent').at(-1) ?? '';
    phase.awaitResult = released.slice(0, 400);
    assert(
      's4',
      'the wait was released with the USER-MESSAGE reason (not stopped)',
      released.includes('was released because the user said something'),
      { returned: phase.awaitResult },
    );
    assert('s4', 'the worker was reported as still running, not stopped', released.includes('worker was not stopped and keeps running'));

    const waitedMs = Date.parse(releasedRequest.t) - Date.parse(awaitCall.t);
    phase.waitedMs = waitedMs;
    assert('s4', 'it returned promptly — far below the 120 s cap', waitedMs < 15000, { waitedMs });

    const settledRequest = readRequests(mock.requestLog).find((entry) =>
      (entry.userTextsAll ?? []).some((text) => text.includes('s4-worker-late-result')),
    );
    phase.workerSettledBeforeRelease = settledRequest !== undefined && Date.parse(settledRequest.t) < Date.parse(releasedRequest.t);
    assert(
      's4',
      'the release came BEFORE the worker settled (it was the user, not the settle, that ended the wait)',
      !phase.workerSettledBeforeRelease,
      { waitedMs, workerSettleSeen: settledRequest !== undefined },
    );

    // The turn continued and answered: the reply the mock scripted AFTER the
    // released result is the assistant's answer in that same turn.
    assert(
      's4',
      'the dispatcher still replied in that turn',
      (releasedRequest.reply?.say ?? '').includes('s4-reply-after-release'),
      { reply: (releasedRequest.reply?.say ?? '').slice(0, 120) },
    );

    // The worker was not stopped: its late result still arrives on a later turn.
    const lateResultTurn = await waitForRequest(
      mock,
      sessionId,
      'the released worker\'s late result to arrive anyway',
      (entry) => (entry.userTextsAll ?? []).some((text) => text.includes('s4-worker-late-result')) && entry.seq > releasedRequest.seq,
      60000,
      [dsh, mock.entry],
    ).catch(() => null);
    phase.lateResultArrived = lateResultTurn !== null;
    assert('s4', 'the released worker kept running and its result arrived later', lateResultTurn !== null);

    phase.status = statusFrom(phase.scenario);
  } catch (error) {
    phase.error = String(error?.message ?? error);
    const log = existsSync(bootLog) ? readFileSync(bootLog, 'utf8') : '';
    phase.diagnostics = diagnosticsFrom(log);
  } finally {
    killTree(dsh.pid);
    killTree(mock.entry.pid);
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
          match: { toolNames: ['spawn_worker'], userIncludes: 'mock-e2e-smoke' },
          say: 'Starting one worker.',
          tool: {
            name: 'spawn_worker',
            input: { stream_key: 'mock-stream', title: 'Mock smoke worker', prompt: 'Reply with exactly: worker-ok' },
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

  if (shouldRun('mock')) await phaseMock();
  if (shouldRun('boot')) await phaseBoot();
  if (shouldRun('dispatch')) {
    const scriptFile = join(OUT, 'script.json');
    writeDispatcherScript(scriptFile);
    await phaseDispatch(scriptFile);
  }
  for (const [name, run] of Object.entries(SCENARIOS)) {
    if (!shouldRun(name)) continue;
    if (!existsSync(SRC_OVERLAY)) throw new Error(`missing ${SRC_OVERLAY}`);
    await run();
  }
} catch (error) {
  failure = error;
  record('error', { message: String(error?.stack ?? error) });
} finally {
  shutdownAll();
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500));

  const alive = [];
  for (const entry of children) {
    if (entry.pid === undefined) continue;
    const check = spawnSync('tasklist', ['/FI', `PID eq ${entry.pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    // Identity, not PID alone: Windows recycles PIDs, so a recycled PID now
    // owned by another executable is not our leak (see launchedProcessAlive).
    if (launchedProcessAlive(entry.pid, entry.image, check.stdout)) {
      alive.push({ label: entry.label, pid: entry.pid, expectedImage: entry.image });
    }
  }
  evidence.processCheck = { launched: children.map(({ label, pid, image }) => ({ label, pid, image })), aliveAfterCleanup: alive };
  assert('cleanup', 'every process the harness launched is dead', alive.length === 0, alive);

  // A phase that was not selected contributes nothing — neither pass nor fail.
  const harnessOk =
    (evidence.phases.mock === undefined || evidence.phases.mock.status === 'pass') &&
    (evidence.phases.boot === undefined || evidence.phases.boot.status === 'pass') &&
    alive.length === 0;
  const dispatchStatus = evidence.phases.dispatch?.status ?? 'skipped';
  // Ticket 120: every scenario that RAN must pass. A phase that was not
  // selected is `undefined`, which must not read as a failure.
  const scenarioStatuses = Object.fromEntries(
    Object.keys(SCENARIOS)
      .filter((name) => evidence.phases[name] !== undefined)
      .map((name) => [name, evidence.phases[name].status]),
  );
  const scenariosOk = Object.values(scenarioStatuses).every((status) => status === 'pass');
  evidence.ok = harnessOk && scenariosOk;
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
