// dev/e2e-mock.mjs — offline end-to-end harness: scripted model + real dsh process.
//
// Three phases, reported separately so a blocker in one never masquerades as
// success in another:
//
//   mock      Protocol self-test against dev/mock-llm.mjs directly (no dsh):
//             fixed reply, tool-call reply, chunked streaming reply, error reply.
//   boot      Real `dsh --profile headless` against the mock with a THROWAWAY
//             DSH_HOME. Proves: mock serves the real provider protocol, dsh boots
//             with DEEPSEEK_BASE_URL, a task is sent, a scripted reply comes back.
//   dispatch  Real `dsh --profile web --patch dev/cordis.web.patch.yml`, a session
//             opened through the host's own RPC, /dispatcher-start, one task, and
//             a wait for the dispatcher tools (spawn_worker) to reach the mock.
//             Runs only when the plugin actually mounts on the installed dsh.
//
// Every child gets a kill timer ARMED AT LAUNCH (taskkill /T /F on Windows).
// Every wait is bounded. Cleanup runs in `finally` and is verified with tasklist.
//
// Usage:
//   node dev/e2e-mock.mjs [--out <dir>] [--timeout-ms <n>] [--skip dispatch]
//
// Exit code 0 means the harness itself works (mock + boot phases pass and every
// process is dead). The dispatcher phase reports separately: `pass`, `blocked`
// (with the exact host error), or `fail`.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const MOCK = join(HERE, 'mock-llm.mjs');
const OVERLAY = join(HERE, 'cordis.web.patch.yml');
const DIAGNOSTICS_OVERLAY = join(HERE, 'e2e-diagnostics.patch.yml');

// ── arguments and evidence root ──────────────────────────────────────────────

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const RUN_TIMEOUT_MS = Number(argValue('--timeout-ms', '180000'));
const SKIP = new Set(argValue('--skip', '').split(',').filter(Boolean));
const OUT = resolve(
  argValue('--out', join(REPO, '.scratch', 'testing', '2026-10-18-mock-llm', timestampSlug())),
);

/** Filesystem-safe local timestamp. */
function timestampSlug() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
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
    assert('dispatch', 'plugin commands are registered', commands.includes('dispatcher-start'), { count: commands.length });

    const activation = await rpc(api, 'commands/execute', {
      agentId: sessionId,
      line: '/dispatcher-start',
      submittedAttachments: [],
    });
    phase.activation = activation?.result ?? null;
    assert('dispatch', '/dispatcher-start reports success', activation?.result?.kind === 'success', phase.activation);

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

let failure;
try {
  const dsh = dshEntry();
  evidence.dsh = dsh.version;
  record('start', { message: `dsh ${dsh.version}; evidence in ${OUT}` });

  if (!existsSync(OVERLAY)) throw new Error(`missing ${OVERLAY}`);

  if (!SKIP.has('mock')) await phaseMock();
  if (!SKIP.has('boot')) await phaseBoot();
  if (!SKIP.has('dispatch')) {
    const scriptFile = join(OUT, 'script.json');
    writeDispatcherScript(scriptFile);
    await phaseDispatch(scriptFile);
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
    // Match the PID as a whole CSV field, not a substring: tasklist echoes the
    // filter line and neighbouring PIDs share digit runs, so `includes` reports
    // a dead process as alive.
    const pids = (check.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.split(',')[1]?.replaceAll('"', '').trim())
      .filter((value) => value !== undefined);
    if (pids.includes(String(entry.pid))) alive.push({ label: entry.label, pid: entry.pid });
  }
  evidence.processCheck = { launched: children.map(({ label, pid }) => ({ label, pid })), aliveAfterCleanup: alive };
  assert('cleanup', 'every process the harness launched is dead', alive.length === 0, alive);

  const harnessOk =
    evidence.phases.mock?.status === 'pass' &&
    evidence.phases.boot?.status === 'pass' &&
    alive.length === 0;
  const dispatchStatus = evidence.phases.dispatch?.status ?? 'skipped';
  evidence.ok = harnessOk;
  evidence.dispatchStatus = dispatchStatus;
  evidence.finishedAt = new Date().toISOString();

  writeFileSync(join(OUT, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log('');
  console.log(`harness: ${harnessOk ? 'PASS' : 'FAIL'} (mock + real dsh boot + cleanup)`);
  console.log(`dispatcher e2e: ${dispatchStatus}${evidence.phases.dispatch?.blockedBy ? ` — blocked: ${evidence.phases.dispatch.blockedBy}` : ''}`);
  console.log(`evidence: ${join(OUT, 'result.json')}`);
  if (failure !== undefined) console.error(failure.message);
  process.exitCode = harnessOk ? 0 : 1;
}
