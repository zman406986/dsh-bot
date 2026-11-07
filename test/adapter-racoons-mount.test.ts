/**
 * Ticket 145 step 8 — the racoons mount's offline suite.
 *
 * What this file proves at the one seam dsh-bot owns
 * (`src/adapter/racoons-mount.ts`, mounted unconditionally inside the
 * plugin's enabled path by `src/plugin.ts`):
 *
 * 1. FULL COVERAGE — a dispatcher-activated session, a worker id that never
 *    entered the lifecycle map, and a plain chat are all processed the same
 *    way: a tool result above the entry floor is captured (journal `entry`),
 *    the entry checkpoint asks one question about it (journal `entry-ask`), the
 *    answer applies (journal `entry-apply`), and a forget becomes one
 *    content-only `surfaceOp: replace` naming a minted recall id; each session
 *    gets its own durable `sessions/<id>/ledger.sqlite` + `blobs/`.
 *    The library's built-in GLOBAL recall stays suppressed: the mount's
 *    context tool host receives no registration, and the plugin-level registry
 *    only gains `recall` when a session activates as a dispatcher.
 *
 * Vocabulary note (ticket 148 re-sync to upstream b5f95cb): upstream ADR-0028
 * removed the judge pass, so the `judge-*` and `verdict-*` journal kinds no
 * longer exist. The entry checkpoint's `entry-ask` / `entry-ask-off` /
 * `entry-ask-refused` / `entry-apply` / `entry-apply-refused` replace them, and
 * the shaped turn's text uses core's `[racoons] kept …` marker instead of the
 * prune lane's `[not retained]` receipt.
 * 2. DURABILITY — after a capping pass the per-session tree exists; the prune
 *    round file is written; after dispose + a fresh `registerRacoonsMount` on
 *    the same root, the archived id recalls the ORIGINAL bytes byte-exactly
 *    and the mount resumes the persisted round (`prune-round-resumed`).
 * 3. PER-SESSION RECALL — two sessions archive their own content; each
 *    session's recall answers its own id and REFUSES the other session's id
 *    (an error, never another session's bytes); unknown ids refuse;
 *    `ledgerOf` throws for a session that never opened.
 * 4. CONFIG MAPPING — `racoonsRecordOnly: true` journals
 *    `enforcement: record-only` and records entries with NO replacement;
 *    an empty root resolves to the library default (`defaultStorageRoot()`);
 *    window `0` mounts with `window: null`, a positive window maps through.
 * 5. TEARDOWN — the disposer closes every cached ledger (a closed ledger
 *    refuses recall) and removes every listener the mount added (the
 *    `agent/pre-step` count returns to baseline); a remount afterwards is
 *    clean and no boundary throws.
 *
 * Offline only (S8): a stub Cordis context, fake dsh sessions shaped like the
 * host's public surface, real SQLite ledgers under the OS temp directory. The
 * entry checkpoint needs a model only to answer one question about one result,
 * so the stream stub below returns the entry lane's own answer grammar
 * (`{"forgetall":"…"}`, `{"keepall":true}`), read by the core's own answer
 * parser; no network, no provider, no real model.
 *
 * Fake-vs-host: the fake session mirrors the shape the vendored mount is
 * written against (`vendor/racoons/adapter/plugin.ts` and its
 * `test/mount-entry.test.ts`): append-only log, `surfaceOp` splicing,
 * `seq === log.length`, frozen payloads, `requestHeader()` for the ask route.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { defaultStorageRoot } from "racoons-dsh/plugin";
import { apply } from "../src/plugin.js";
import {
  createJournalSink,
  RACOONS_JOURNAL_FULL_TEXT_ENV,
  registerRacoonsMount,
  type RacoonsMountHandle,
} from "../src/adapter/racoons-mount.js";
import { DISPATCHER_START_COMMAND } from "../src/adapter/index.js";
import type { AdapterContext, AgentLike } from "../src/adapter/cordis-dsh-host.js";
import { volatileConfig } from "./support/plugin-config.js";

// ── the journal (the mount's only evidence channel) ────────────────────────

interface JournalRecord {
  readonly kind: string;
  readonly fields: Record<string, unknown>;
}

interface JournalCapture {
  records(): JournalRecord[];
  reset(): void;
  restore(): void;
}

function parseJournalLine(line: string): JournalRecord {
  const rest = line.slice("racoons: ".length);
  const space = rest.indexOf(" ");
  const kind = space < 0 ? rest : rest.slice(0, space);
  let fields: Record<string, unknown> = {};
  if (space >= 0) {
    try {
      const parsed: unknown = JSON.parse(rest.slice(space + 1));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        fields = parsed as Record<string, unknown>;
      }
    } catch {
      // The mount degrades to the kind alone when a record cannot render;
      // the line still counts, it just carries no fields.
    }
  }
  return { kind, fields };
}

/** Swap `console.info` for the duration of one test; `t.after` restores it. */
function captureJournal(): JournalCapture {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  const records = (): JournalRecord[] =>
    lines.filter((line) => line.startsWith("racoons: ")).map(parseJournalLine);
  return {
    records,
    reset: () => {
      lines.length = 0;
    },
    restore: () => {
      console.info = original;
    },
  };
}

function recordsOfKind(records: readonly JournalRecord[], kind: string): JournalRecord[] {
  return records.filter((record) => record.kind === kind);
}

function forSession(
  records: readonly JournalRecord[],
  kind: string,
  sessionId: string,
): JournalRecord[] {
  return records.filter(
    (record) => record.kind === kind && record.fields["sessionId"] === sessionId,
  );
}

function firstRecord(
  records: readonly JournalRecord[],
  kind: string,
  predicate: (fields: Record<string, unknown>) => boolean = () => true,
): JournalRecord | undefined {
  return records.find((record) => record.kind === kind && predicate(record.fields));
}

/** The one `mounted` line a mount writes at apply. */
function mountedRecord(records: readonly JournalRecord[]): JournalRecord {
  const mounted = firstRecord(records, "mounted");
  assert.ok(mounted, "the mount journals its `mounted` line");
  return mounted;
}

// ── temp storage roots ────────────────────────────────────────────────────

/**
 * Roots this file created. `t.after` hooks run in REGISTRATION order, and every
 * test registers its mount/context disposer after its root, so a per-test
 * `t.after` here would delete the directory while SQLite still holds it. The
 * file-level hook below runs once, after every test's own disposer has closed
 * its ledgers.
 */
const tempRoots: string[] = [];

after(() => {
  for (const dir of tempRoots) {
    // Windows can hold a WAL handle for a tick after close; the retry loop is
    // the same one the vendored adapter's own tests use.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 25 });
    } catch {
      // The OS owns the temp directory; never fail a green run on cleanup.
    }
  }
  tempRoots.length = 0;
});

/** One per-test durable root, removed after the whole file has torn down. */
function scratchRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-racoons-mount-"));
  tempRoots.push(dir);
  return dir;
}

// ── fake sessions (the host shape the vendored mount reads) ────────────────

interface FakeEvent {
  readonly type: string;
  readonly seq: number;
  readonly data?: unknown;
  readonly surfaceOp?: unknown;
  readonly sourceEventSeqs?: readonly number[];
}

interface FakeSession {
  readonly id: string;
  readonly log: FakeEvent[];
  readonly surface: { nodes: number[] };
  readonly seq: number;
  eventAt(seq: number): FakeEvent | undefined;
  append(type: string, data: unknown, options?: Record<string, unknown>): FakeEvent;
  on(listener: (session: FakeSession, event: FakeEvent) => void): () => void;
  requestHeader(): { config: { provider: string; model: string } };
}

function fakeSession(id: string): FakeSession {
  const log: FakeEvent[] = [];
  const surfaceNodes: number[] = [];
  const listeners = new Set<(session: FakeSession, event: FakeEvent) => void>();
  const session: FakeSession = {
    id,
    log,
    surface: { nodes: surfaceNodes },
    get seq() {
      return log.length;
    },
    eventAt: (seq: number) => log[seq],
    append(type, data, options = {}) {
      const seq = log.length;
      const surfaceOp = options["surfaceOp"];
      if (surfaceOp === "append") {
        surfaceNodes.push(seq);
      } else if (surfaceOp !== undefined) {
        const op = surfaceOp as { startSeq: number; endSeq: number };
        const start = surfaceNodes.indexOf(op.startSeq);
        const end = surfaceNodes.indexOf(op.endSeq);
        if (start < 0 || end < 0) {
          throw new Error(
            `surface replace: seq out of surface (${String(op.startSeq)}..${String(op.endSeq)})`,
          );
        }
        surfaceNodes.splice(start, end - start + 1, seq);
      }
      const sourceEventSeqs = options["sourceEventSeqs"];
      const event: FakeEvent = Object.freeze({
        type,
        seq,
        data: Object.freeze(structuredClone(data)),
        ...(surfaceOp === undefined ? {} : { surfaceOp }),
        ...(sourceEventSeqs === undefined
          ? {}
          : { sourceEventSeqs: Object.freeze([...(sourceEventSeqs as number[])]) }),
      });
      log.push(event);
      for (const listener of [...listeners]) listener(session, event);
      return event;
    },
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    requestHeader() {
      return { config: { provider: "stub", model: "stub" } };
    },
  };
  return session;
}

/** Append one scripted dsh step in the event order a live run produces. */
function scriptStep(
  session: FakeSession,
  params: {
    turn: number;
    step: number;
    toolCall?: { id: string; name: string; input: Record<string, unknown> };
    result?: { content: unknown[]; meta?: unknown };
    userText?: string;
    endTurn?: boolean;
  },
): void {
  session.append("turn/start", { turn: params.turn });
  session.append("step/start", { turn: params.turn, step: params.step });
  session.append(
    "system/message",
    {
      turn: params.turn,
      step: params.step,
      message: {
        role: "system",
        content: [{ type: "text", text: "sys" }],
        source: { kind: "system-prompt" },
        id: `sys-${String(params.turn)}`,
      },
    },
    { surfaceOp: "append" },
  );
  session.append(
    "user/message",
    {
      content: [{ type: "text", text: params.userText ?? `task ${String(params.turn)}` }],
      source: { kind: "user" },
      role: "user",
      id: `user-${String(params.turn)}`,
    },
    { surfaceOp: "append" },
  );
  if (params.toolCall !== undefined) {
    const call = params.toolCall;
    const argumentsText = JSON.stringify(call.input);
    const callSeq = session.append("tool/call", {
      turn: params.turn,
      step: params.step,
      callId: call.id,
      name: call.name,
      arguments: argumentsText,
    }).seq;
    session.append(
      "assistant/message",
      {
        turn: params.turn,
        step: params.step,
        message: {
          role: "assistant",
          source: { kind: "model", provider: "stub", model: "stub" },
          content: [
            { type: "tool-call", id: call.id, name: call.name, arguments: argumentsText },
          ],
          id: `asst-${call.id}`,
        },
      },
      { surfaceOp: "append" },
    );
    if (params.result !== undefined) {
      session.append(
        "tool/result",
        {
          turn: params.turn,
          step: params.step,
          message: {
            role: "tool",
            source: { kind: "tool", callId: call.id },
            toolCallId: call.id,
            content: params.result.content,
            isError: false,
            id: `result-${call.id}`,
          },
          ...(params.result.meta === undefined ? {} : { meta: params.result.meta }),
        },
        { surfaceOp: "append", sourceEventSeqs: [callSeq] },
      );
    }
  }
  session.append("step/end", { turn: params.turn, step: params.step });
  if (params.endTurn === true) {
    session.append("turn/end", { turn: params.turn, reason: { kind: "completed" } });
  }
}

/** A body comfortably over the 8192-byte bar, line-addressable and multi-byte. */
function oversizedBody(bytes: number, tag: string): string {
  const line = `${tag} λ→ ${"x".repeat(32)}`;
  const lines: string[] = [];
  let size = 0;
  while (size < bytes) {
    lines.push(line);
    size += Buffer.byteLength(line, "utf8") + 1;
  }
  return lines.join("\n");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

// ── the canned model seam (the vendored tests' deterministic answer) ──────

interface CannedLlm {
  readonly requests: unknown[];
  stream(options: unknown): AsyncIterable<unknown>;
}

function cannedLlm(answer: string): CannedLlm {
  const requests: unknown[] = [];
  return {
    requests,
    stream(options: unknown) {
      requests.push(options);
      return (async function* emit() {
        yield { type: "text-delta", index: 0, text: answer.slice(0, 5) };
        if (answer.length > 5) yield { type: "text-delta", index: 0, text: answer.slice(5) };
        yield { type: "finish", reason: "stop" };
      })();
    },
  };
}

/**
 * The one entry-checkpoint answer this file's passes read.
 *
 * The entry lane's grammar is one action object per ask (`core/verdicts/
 * entry-wire.ts`): `{"forgetall": "<summary ≤ 25 words>"}` drops the whole
 * landed result and banks it, `{"keepall": true}` keeps it whole. The old
 * index-keyed prune table (`{"1":{"forgetall":"…"}}`) is not an entry answer
 * at all — the parser refuses it `unknown-action`.
 */
const FORGET_ALL_ANSWER = '{"forgetall":"oversized read"}';
/** The keep-all answer: the exchange is rewound and the result keeps its bytes. */
const KEEP_ALL_ANSWER = '{"keepall":true}';

function emptyStream(): AsyncIterable<never> {
  return (async function* none() {})();
}

/** Main's last dispatched request, as the host's `llm/stream` waterfall hands it over. */
function mainWire(sessionId: string): Record<string, unknown> {
  return {
    sessionId,
    provider: "stub",
    model: "stub",
    system: "MAIN SYSTEM PROMPT",
    tools: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "read big.txt" }] }],
  };
}

// ── listeners / buses ─────────────────────────────────────────────────────

type Listener = (...args: never[]) => unknown;

/** The bus every stub context shares: `on` with a real disposer, plus firing. */
function createBus() {
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    on(name: string, listener: Listener): () => void {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((entry) => entry !== listener),
        );
      };
    },
    listenerCount(name: string): number {
      return (listeners.get(name) ?? []).length;
    },
    /** Deliver an event to every live listener, awaiting each in order. */
    async fire(name: string, ...args: unknown[]): Promise<unknown> {
      let result: unknown;
      for (const listener of [...(listeners.get(name) ?? [])]) {
        result = await (listener as (...values: unknown[]) => unknown)(...args);
      }
      return result;
    },
    fireSync(name: string, ...args: unknown[]): void {
      for (const listener of [...(listeners.get(name) ?? [])]) {
        (listener as (...values: unknown[]) => unknown)(...args);
      }
    },
  };
}

interface MountCtx extends ReturnType<typeof createBus> {
  get(name: string): unknown;
  /** The context's own tool registry: the global host the mount must NOT use. */
  readonly toolRegistrations: unknown[];
  readonly tools: { register(definition: unknown): () => void };
}

/**
 * The minimal mount context. It deliberately carries a working `tools`
 * registry: the mount must hand the library its own no-op host, so this spy
 * staying empty is the "no global recall" proof at the mount seam.
 */
function createMountCtx(services: Record<string, unknown> = {}): MountCtx {
  const bus = createBus();
  const toolRegistrations: unknown[] = [];
  return {
    ...bus,
    toolRegistrations,
    get(name: string) {
      return services[name];
    },
    tools: {
      register(definition: unknown) {
        toolRegistrations.push(definition);
        return () => {
          const at = toolRegistrations.indexOf(definition);
          if (at >= 0) toolRegistrations.splice(at, 1);
        };
      },
    },
  };
}

interface ApplyCtx extends ReturnType<typeof createBus> {
  readonly disposers: Array<() => unknown>;
  readonly toolRegistrations: unknown[];
  /** Every command definition currently registered (the spy, not the registry). */
  readonly registeredCommands: Array<{
    name: string;
    handler: (invocation: never) => unknown;
  }>;
  readonly toolsRegistry: {
    schemas(): ReadonlyArray<{ name: string }>;
    register(definition: unknown): () => void;
  };
  readonly commandsRegistry: {
    register(definition: { name: string; handler: (invocation: never) => unknown }): () => void;
  };
  effect(execute: () => unknown, label?: string): void;
  inject(services: readonly string[], callback: (child: unknown) => void): void;
  get(name: string): unknown;
  subagents: {
    startActivation(): Promise<never>;
    interrupt(): void;
    sendMessage(): Promise<string>;
  };
  agents: { get(): undefined };
  jobs: { list(): unknown[] };
  storageDomain: { open(): Promise<unknown> };
  readonly tables: Map<string, Map<string, unknown>>;
  runCommand(commandId: string, invocation: unknown): unknown;
}

/**
 * The plugin-level context: the same listener/effect contract the other plugin
 * suites use (ticket 44 effect semantics), plus a recording tool registry and
 * a durable-domain stub, so the real `apply()` runs unmodified.
 */
function createApplyCtx(services: Record<string, unknown> = {}): ApplyCtx {
  const bus = createBus();
  const disposers: Array<() => unknown> = [];
  const toolRegistrations: unknown[] = [];
  const registeredCommands: ApplyCtx["registeredCommands"] = [];
  const tables = new Map<string, Map<string, unknown>>();

  const ctx: ApplyCtx = {
    ...bus,
    disposers,
    toolRegistrations,
    registeredCommands,
    toolsRegistry: {
      schemas: () =>
        toolRegistrations
          .map((tool) => (tool as { name?: unknown }).name)
          .filter((name): name is string => typeof name === "string")
          .map((name) => ({ name })),
      register(definition: unknown) {
        toolRegistrations.push(definition);
        return () => {
          const at = toolRegistrations.indexOf(definition);
          if (at >= 0) toolRegistrations.splice(at, 1);
        };
      },
    },
    commandsRegistry: {
      register(definition) {
        registeredCommands.push(definition);
        return () => {
          const at = registeredCommands.indexOf(definition);
          if (at >= 0) registeredCommands.splice(at, 1);
        };
      },
    },
    effect(execute, label) {
      void label;
      const result = execute();
      if (typeof result === "function") {
        disposers.push(result as () => unknown);
        return;
      }
      if (result !== null && typeof result === "object" && Symbol.iterator in result) {
        for (const step of result as Iterable<unknown>) {
          if (typeof step === "function") disposers.push(step as () => unknown);
        }
      }
    },
    inject(services, callback) {
      // No settings or projection service in this stub: the optional injects
      // stay dormant, exactly like a host that has not mounted them.
      void services;
      void callback;
    },
    get(name) {
      return services[name];
    },
    subagents: {
      async startActivation() {
        throw new Error("spawn is not exercised by this suite");
      },
      interrupt() {},
      async sendMessage() {
        return "msg-stub";
      },
    },
    agents: { get: () => undefined },
    jobs: { list: () => [] },
    storageDomain: {
      async open() {
        let table = tables.get("stub");
        if (table === undefined) {
          table = new Map<string, unknown>();
          tables.set("stub", table);
        }
        const current = table;
        return {
          table() {
            return {
              get: (key: string) => current.get(key) as never,
              entries: () => current.entries() as never,
              async put(key: string, value: unknown) {
                current.set(key, value);
              },
              async delete(key: string) {
                return current.delete(key);
              },
            };
          },
          async close() {},
          name: "stub",
        };
      },
    },
    tables,
    runCommand(commandId, invocation) {
      const command = registeredCommands.find((entry) => entry.name === commandId);
      if (command === undefined) throw new Error(`command not registered: ${commandId}`);
      return command.handler(invocation as never);
    },
  } as ApplyCtx;

  // The live context exposes these under their own names.
  const live = ctx as ApplyCtx & { tools: unknown; commands: unknown };
  live.tools = ctx.toolsRegistry;
  live.commands = ctx.commandsRegistry;
  return ctx;
}

/**
 * ADR-0019: the live host mints a scoped tool surface per agent, and the
 * plugin refuses the retired process-global fallback. `toolRegistrations` is
 * the harness's recorder, so the scoped registrations are mirrored there for
 * the existing assertions while the real duplicate/cleanup semantics live on
 * this agent's own map.
 */
function scopedAgentTools(ctx: ApplyCtx) {
  const scoped = new Map<string, unknown>();
  return {
    schemas: () => [...scoped.keys()].map((name) => ({ name })),
    register(definition: unknown) {
      const name = (definition as { name?: unknown }).name;
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("tool definition needs a non-empty name");
      }
      if (scoped.has(name)) {
        throw new Error(`tool "${name}" is already registered`);
      }
      scoped.set(name, definition);
      ctx.toolRegistrations.push(definition);
      return () => {
        scoped.delete(name);
        const at = ctx.toolRegistrations.indexOf(definition);
        if (at >= 0) ctx.toolRegistrations.splice(at, 1);
      };
    },
  };
}

/** Run the real plugin apply against the stub context. */
function applyPlugin(
  ctx: ApplyCtx,
  config: Parameters<typeof volatileConfig>[0],
): void {
  apply(
    ctx as unknown as AdapterContext & {
      effect: ApplyCtx["effect"];
      inject: ApplyCtx["inject"];
      get: ApplyCtx["get"];
    } as never,
    // Owner ruling 2026-11-05: racoons is off unless a manual overlay turns
    // it on. This harness is that overlay — every test in this file exercises
    // the racoons-enabled path, so the switch is set here rather than
    // defaulted on in the product.
    volatileConfig({ ...config, racoonsEnabled: true }),
  );
  assert.ok(
    ctx.registeredCommands.some((command) => command.name === DISPATCHER_START_COMMAND),
    "apply reached the enabled path (the activation command is registered)",
  );
}

function disposeAll(ctx: ApplyCtx): void {
  for (const dispose of [...ctx.disposers].reverse()) {
    try {
      dispose();
    } catch {
      // Teardown only; the assertions after the dispose name what must be gone.
    }
  }
}

/** Let queued async chains (ledger close, activation rebuild) run to rest. */
async function flush(): Promise<void> {
  for (let index = 0; index < 16; index += 1) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
}

// ── session plumbing shared by the tests ─────────────────────────────────

/** Pipe every host event the fake session emits into the context's bus. */
function attachSession(session: FakeSession, ctx: ReturnType<typeof createBus>): void {
  session.on((emitting, event) => {
    ctx.fireSync("session/event", emitting, event);
  });
}

/** Deliver main's outgoing request; the listener must always call next(). */
async function sendMainWire(
  ctx: ReturnType<typeof createBus>,
  sessionId: string,
): Promise<void> {
  let nextCalled = false;
  await ctx.fire("llm/stream", mainWire(sessionId), () => {
    nextCalled = true;
    return emptyStream();
  });
  assert.equal(nextCalled, true, "the llm/stream listener observes; it never intercepts");
}

/** Fire one step boundary the way the host's waterfall does. */
async function runStep(
  ctx: ReturnType<typeof createBus>,
  session: FakeSession,
  turn: number,
  step: number,
): Promise<void> {
  await ctx.fire(
    "agent/pre-step",
    { agent: { session }, messages: [], turn, step, signal: {} },
    async () => ({ kind: "enter", messages: [] }),
  );
}

/** One scripted oversized read, ending its turn so the result is not in flight. */
async function cappingPass(
  ctx: ReturnType<typeof createBus>,
  session: FakeSession,
  callId: string,
  body: string,
): Promise<void> {
  await sendMainWire(ctx, session.id);
  scriptStep(session, {
    turn: 1,
    step: 1,
    toolCall: { id: callId, name: "read", input: { file_path: "big.txt" } },
    result: { content: [{ type: "text", text: body }], meta: { path: "big.txt" } },
    endTurn: true,
  });
  await runStep(ctx, session, 1, 2);
}

function replacementEvents(session: FakeSession): FakeEvent[] {
  return session.log.filter(
    (event) => event.type === "tool/result" && typeof event.surfaceOp === "object",
  );
}

function appendedResults(session: FakeSession): FakeEvent[] {
  return session.log.filter(
    (event) => event.type === "tool/result" && event.surfaceOp === "append",
  );
}

function messageText(event: FakeEvent | undefined): string {
  const data = event?.data as
    | { message?: { content?: Array<{ text?: string }> } }
    | undefined;
  return data?.message?.content?.[0]?.text ?? "";
}

const RECALL_ID = /recall (recall:sha256:[0-9a-f]{64})/u;

function recallIdOf(text: string): string {
  const match = RECALL_ID.exec(text);
  assert.ok(match !== null, `the replacement names a recall id: ${text}`);
  return match[1] as string;
}

/**
 * Assert the full capture→ask→apply→replace flow for one session, and return
 * what the replacement said.
 *
 * At upstream b5f95cb (ticket 148) the entry checkpoint is the one seam that
 * decides a landed result, so the evidence is the `entry` journal line, the
 * `entry-ask` line naming the landed unit and the answer, the `entry-apply`
 * line naming the surface write, and then the one `surfaceOp: replace` event.
 * There is no `publish` line on this path, and the judge's old
 * `verdict-settled` no longer exists (ADR-0028).
 */
function assertCapped(
  records: readonly JournalRecord[],
  session: FakeSession,
  body: string,
): string {
  const sessionId = session.id;
  assert.equal(forSession(records, "entry", sessionId).length, 1, `entry for ${sessionId}`);

  const asked = firstRecord(
    records,
    "entry-ask",
    (fields) => fields["sessionId"] === sessionId,
  );
  assert.ok(asked, `entry-ask for ${sessionId}`);
  assert.equal(asked.fields["action"], "forgetall", `${sessionId}: the answer drops the result`);
  assert.equal(typeof asked.fields["unitId"], "string", `${sessionId}: the ask names the unit`);

  const applied = firstRecord(
    records,
    "entry-apply",
    (fields) => fields["sessionId"] === sessionId,
  );
  assert.ok(applied, `entry-apply for ${sessionId}`);
  assert.equal(applied.fields["status"], "landed", `${sessionId}: a forget lands its shape`);
  assert.equal(applied.fields["engineStatus"], "applied", `${sessionId}: the engine applied it`);
  assert.equal(applied.fields["action"], "forgetall", `${sessionId}: the applied action`);

  const origin = appendedResults(session)[0];
  assert.ok(origin, `${sessionId}: the original result is in the log`);
  assert.equal(messageText(origin), body);
  const replacements = replacementEvents(session);
  assert.equal(replacements.length, 1, `${sessionId}: one content-only replacement`);
  const replacement = replacements[0] as FakeEvent;
  assert.deepEqual(replacement.surfaceOp, {
    op: "replace",
    startSeq: origin.seq,
    endSeq: origin.seq,
  });
  assert.deepEqual([...(replacement.sourceEventSeqs ?? [])], [origin.seq]);
  const text = messageText(replacement);
  // The shaped turn is the answer's summary above core's own marker
  // (`SHAPE_MARKER_*` in core/rules/assets-templates.ts): a forgetall keeps no
  // line, so the marker is the empty-keep form and names the recall id.
  assert.match(text, /^oversized read\n\n\[racoons\] kept 0 of \d+ lines · recall /u,
    "the shipped shaped-turn form");
  assert.ok(text.length < body.length / 2, "the body itself is not retained");
  return recallIdOf(text);
}

/** Assert one session's archive holds exactly the original bytes. */
async function assertRecallIsExact(
  recall: (id: string) => Promise<{
    id: string;
    parts: ReadonlyArray<{ bytes: Uint8Array; source: { sha256: string } }>;
  }>,
  recallId: string,
  body: string,
  label: string,
): Promise<void> {
  const record = await recall(recallId);
  assert.equal(record.id, recallId, `${label}: the ledger answers the asked id`);
  assert.equal(record.parts.length, 1, `${label}: one archived part`);
  const part = record.parts[0];
  assert.ok(part, `${label}: the part exists`);
  assert.equal(part.source.sha256, sha256Hex(body), `${label}: the archived sha is the original`);
  assert.equal(
    Buffer.compare(Buffer.from(part.bytes), Buffer.from(body, "utf8")),
    0,
    `${label}: the archived bytes are byte-identical`,
  );
}

/** Mount one session on a fresh handle; the caller disposes. */
function mountSession(
  ctx: ReturnType<typeof createMountCtx>,
  root: string,
  options: { enforcement?: "apply" | "record-only"; contextWindowTokens?: number | null } = {},
): RacoonsMountHandle {
  return registerRacoonsMount(ctx, {
    enforcement: options.enforcement ?? "apply",
    racoonsStorageRoot: root,
    contextWindowTokens: options.contextWindowTokens ?? null,
  });
}

// ── 1. full coverage: no session filter, no global recall ─────────────────

describe("ticket 145 — the mount has no session filter", () => {
  // Owner ruling 2026-11-05: racoons is an OPTIONAL test feature. This is the
  // pin that keeps it out of the default product — no switch, no mount.
  it("racoonsEnabled absent or false mounts nothing (default product)", async (t) => {
    const journal = captureJournal();
    t.after(journal.restore);

    const ctx = createApplyCtx({ llm: cannedLlm(FORGET_ALL_ANSWER) });
    // Raw apply, NOT `applyPlugin`: this is the one test that must run with
    // the racoons switch absent, i.e. the shipped default.
    apply(
      ctx as unknown as AdapterContext & {
        effect: ApplyCtx["effect"];
        inject: ApplyCtx["inject"];
        get: ApplyCtx["get"];
      } as never,
      volatileConfig({ enabled: true, racoonsStorageRoot: scratchRoot() }),
    );
    t.after(() => {
      disposeAll(ctx);
    });

    // No mount listeners, no ledger traffic — the plugin behaves exactly as if
    // racoons were not vendored.
    assert.equal(ctx.listenerCount("agent/pre-step"), 0);
    assert.equal(ctx.listenerCount("llm/stream"), 0);
    assert.equal(ctx.listenerCount("agent/turn-stopping"), 0);
    assert.equal(journal.records().length, 0, "no mount line, nothing ran");

    // And no per-session recall tool rides an activated dispatcher's surface.
    const agent: AgentLike = {
      session: { id: "sess-off", header: { parentSession: null, delegationDepth: 0 } },
      followup() {},
      ctx: { tools: scopedAgentTools(ctx) },
    };
    const activation = ctx.runCommand(DISPATCHER_START_COMMAND, {
      commandId: DISPATCHER_START_COMMAND,
      agent,
    }) as { kind: string };
    assert.equal(activation.kind, "success");
    await flush();
    const names = ctx.toolRegistrations.map(
      (tool) => (tool as { name?: string }).name,
    );
    assert.ok(names.includes("spawn_worker"), "the dispatcher surface still exists");
    assert.ok(!names.includes("recall"), "no recall tool without racoons");
  });

  it("a dispatcher activation adds exactly one per-session recall; other sessions add none", async (t) => {
    const root = scratchRoot();
    const journal = captureJournal();
    t.after(journal.restore);

    const ctx = createApplyCtx({ llm: cannedLlm(FORGET_ALL_ANSWER) });
    applyPlugin(ctx, {
      enabled: true,
      racoonsStorageRoot: root,
      racoonsContextWindowTokens: 0,
    });
    t.after(() => {
      disposeAll(ctx);
    });

    // Unconditional mount: the boundary listener exists before ANY activation.
    assert.equal(ctx.listenerCount("agent/pre-step"), 1);
    assert.equal(ctx.listenerCount("llm/stream"), 1);
    assert.equal(
      ctx.toolRegistrations.filter((tool) => (tool as { name?: string }).name === "recall")
        .length,
      0,
      "apply registers no recall globally",
    );

    const dispatcherId = "sess-activated";
    const workerId = "worker-never-registered";
    const plainId = "plain-chat-never-activated";
    const results: Record<string, { body: string; recallId: string }> = {};
    for (const entry of [
      { id: dispatcherId, body: oversizedBody(40 * 1024, "ACTIVATED"), callId: "c-a1" },
      { id: workerId, body: oversizedBody(40 * 1024, "WORKER"), callId: "c-w2" },
      { id: plainId, body: oversizedBody(40 * 1024, "PLAIN"), callId: "c-p2" },
    ]) {
      const session = fakeSession(entry.id);
      attachSession(session, ctx);
      await cappingPass(ctx, session, entry.callId, entry.body);
      results[entry.id] = {
        body: entry.body,
        recallId: assertCapped(journal.records(), session, entry.body),
      };
    }

    // Activate the dispatcher chat: the plugin registers the dispatcher tool
    // surface on the agent's OWN scoped context (ADR-0019), and the ticket-145
    // recall rides that same surface.
    const agent: AgentLike & { readonly injected: unknown[] } = {
      session: { id: dispatcherId, header: { parentSession: null, delegationDepth: 0 } },
      followup() {},
      ctx: { tools: scopedAgentTools(ctx) },
      inject(message: unknown) {
        (this.injected as unknown[]).push(message);
      },
      injected: [],
    };
    const activation = ctx.runCommand(DISPATCHER_START_COMMAND, {
      commandId: DISPATCHER_START_COMMAND,
      agent,
    }) as { kind: string };
    assert.equal(activation.kind, "success");
    await flush();

    const recallTools = ctx.toolRegistrations.filter(
      (tool) => (tool as { name?: string }).name === "recall",
    );
    assert.equal(recallTools.length, 1, "exactly one recall for the activated session");

    const tool = recallTools[0] as {
      execute(args: unknown): Promise<{ recallId: string; text: string | null; byteLength: number }>;
    };
    // It answers the dispatcher's own archive with the original text...
    const own = await tool.execute({ id: results[dispatcherId]?.recallId });
    assert.equal(own.recallId, results[dispatcherId]?.recallId);
    assert.equal(own.text, results[dispatcherId]?.body);
    // ...and refuses another session's id: the handler reads the activating
    // session's ledger only, so this is a miss, never the wrong bytes.
    for (const otherId of [workerId, plainId]) {
      await assert.rejects(
        () => tool.execute({ id: results[otherId]?.recallId }),
        /Missing recall|not-found|Invalid recall id/u,
        `the dispatcher's recall refuses ${otherId}'s archive`,
      );
    }

    // The worker and the plain chat never activated, so they contributed no
    // tool registration of any kind: coverage is session-level, not lifecycle.
    // Eight dispatcher tools + this one recall, all from the single activation
    // — the mount added nothing globally. (Ticket 174 / ADR-0033 removed the
    // global `request_access`.)
    assert.deepEqual(
      ctx.toolRegistrations
        .map((toolEntry) => (toolEntry as { name?: string }).name)
        .sort(),
      [
        "await_agent",
        "check_workers",
        "deliver_result",
        "message_agent",
        "recall",
        "spawn_dispatcher",
        "spawn_worker",
        "steer_worker",
        "stop_worker",
      ],
    );
  });
});

// ── 2. durability: the tree persists, recall is byte-exact after remount ───

describe("ticket 145 — durable per-session storage", () => {
  it("writes the session tree and prune round; a fresh mount recalls the original bytes", async (t) => {
    const root = scratchRoot();
    const journal = captureJournal();
    t.after(journal.restore);

    const sessionId = "sess-durable";
    const body = oversizedBody(40 * 1024, "DURABLE");
    const firstCtx = createMountCtx({ llm: cannedLlm(FORGET_ALL_ANSWER) });
    const first = mountSession(firstCtx, root);
    const session = fakeSession(sessionId);
    attachSession(session, firstCtx);

    await cappingPass(firstCtx, session, "c-dur", body);
    const firstRecords = journal.records();
    const recallId = assertCapped(firstRecords, session, body);

    // The durable tree the ticket names: ledger, blob bodies, prune round.
    const databasePath = join(root, "sessions", sessionId, "ledger.sqlite");
    const blobRoot = join(root, "sessions", sessionId, "blobs");
    assert.ok(existsSync(databasePath));
    assert.ok(existsSync(blobRoot));
    assert.ok(existsSync(join(blobRoot, "sha256")));

    // One `/prune` message runs a pass at the next boundary and persists its
    // round beside the ledger (the round is what a restart must not reuse).
    session.append(
      "user/message",
      {
        content: [{ type: "text", text: "/prune" }],
        source: { kind: "user" },
        role: "user",
        id: "prune-1",
      },
      { surfaceOp: "append" },
    );
    await runStep(firstCtx, session, 2, 1);
    const roundRecords = journal.records();
    assert.ok(firstRecord(roundRecords, "prune-requested"), "the /prune message was observed");
    assert.ok(firstRecord(roundRecords, "prune-plan"), "the pass planned");
    const roundFile = join(root, "sessions", sessionId, "prune-round.json");
    assert.ok(existsSync(roundFile), "the pass persisted its round");
    assert.deepEqual(JSON.parse(readFileSync(roundFile, "utf8")), { round: 1 });

    // Dispose: the mount owns the ledgers, so it is the only place they close.
    const firstLedger = first.ledgerOf(sessionId);
    await first.dispose();
    await assert.rejects(
      () => firstLedger.recall(recallId as never),
      /closed|Trash ledger is closed/u,
      "dispose closed the cached ledger",
    );
    assert.throws(() => first.ledgerOf(sessionId), /no ledger is open/u);

    // Remount: a fresh handle and a fresh ledger cache over the SAME root.
    journal.reset();
    const secondCtx = createMountCtx({});
    const second = mountSession(secondCtx, root);
    t.after(() => {
      void second.dispose();
    });
    const reopened = fakeSession(sessionId);
    attachSession(reopened, secondCtx);
    await runStep(secondCtx, reopened, 1, 1);

    const secondRecords = journal.records();
    const resumed = firstRecord(
      secondRecords,
      "prune-round-resumed",
      (fields) => fields["sessionId"] === sessionId,
    );
    assert.ok(resumed, "the remount resumed the persisted round");
    assert.equal(resumed.fields["round"], 1);
    // Resumption happens before the first boundary runs, i.e. while the entry
    // is opened (the line precedes the `at-rest` of the boundary that opened it).
    const resumedAt = secondRecords.indexOf(resumed);
    const atRestAt = secondRecords.findIndex(
      (record) => record.kind === "at-rest" && record.fields["sessionId"] === sessionId,
    );
    assert.ok(atRestAt > resumedAt, "the resumed round is read before the at-rest pass");

    // Byte-exact recall of the ORIGINAL bytes, through the shipped tool shape.
    const defs = second.recallToolDefs(sessionId);
    assert.equal(defs.length, 1, "one shipped recall tool definition");
    const def = defs[0] as {
      name: string;
      execute(args: unknown): Promise<{
        recallId: string;
        text: string | null;
        byteLength: number;
        parts: Array<{ byteLength: number; sha256: string; text: string }>;
      }>;
    };
    assert.equal(def.name, "recall");
    const output = await def.execute({ id: recallId });
    assert.equal(output.recallId, recallId);
    assert.equal(output.text, body, "the recalled text is the original");
    assert.equal(output.byteLength, Buffer.byteLength(body, "utf8"));
    assert.equal(output.parts[0]?.sha256, sha256Hex(body));
    assert.equal(output.parts[0]?.byteLength, Buffer.byteLength(body, "utf8"));
    assert.equal(
      Buffer.compare(Buffer.from(output.parts[0]?.text ?? "", "utf8"), Buffer.from(body, "utf8")),
      0,
      "the restored bytes are byte-identical",
    );

    // And the raw record agrees (the tool projects this same part).
    const record = await second.recallFor(sessionId)(recallId);
    assert.equal(record.manifest.sessionId, sessionId);
    assert.equal(
      Buffer.compare(
        Buffer.from(record.parts[0]?.bytes ?? new Uint8Array()),
        Buffer.from(body, "utf8"),
      ),
      0,
    );
  });
});

// ── 3. per-session recall: own id only, refusals are errors ────────────────

describe("ticket 145 — per-session recall", () => {
  it("the worker-seam definitions read the worker's own ledger", async (t) => {
    const root = scratchRoot();
    const journal = captureJournal();
    t.after(journal.restore);

    const ctx = createMountCtx({ llm: cannedLlm(FORGET_ALL_ANSWER) });
    const mount = mountSession(ctx, root);
    t.after(() => {
      void mount.dispose();
    });

    // `recallToolDefs` is exactly what the plugin's `workerLocalTools` hands to
    // `applyWorkerComposition` for the child's own scope
    // (src/plugin.ts:684 → src/adapter/cordis-dsh-host.ts:1546 →
    // src/worker/preset.ts:112). Proving these definitions read the worker's
    // ledger proves the worker seam, without a spawn.
    const worker = {
      id: "worker-scope-1",
      body: oversizedBody(40 * 1024, "WORKER-SCOPE"),
      callId: "c-ws",
    };
    const parent = {
      id: "sess-parent",
      body: oversizedBody(40 * 1024, "PARENT"),
      callId: "c-ps",
    };
    const logs = new Map<string, FakeSession>();
    for (const entry of [worker, parent]) {
      const session = fakeSession(entry.id);
      logs.set(entry.id, session);
      attachSession(session, ctx);
      await cappingPass(ctx, session, entry.callId, entry.body);
    }
    const workerRecallId = assertCapped(
      journal.records(),
      logs.get(worker.id) as FakeSession,
      worker.body,
    );
    const parentRecallId = assertCapped(
      journal.records(),
      logs.get(parent.id) as FakeSession,
      parent.body,
    );

    // One shipped definition, named `recall` (never `forget`/`expand`, which
    // have no execution path).
    const defs = mount.recallToolDefs(worker.id);
    assert.equal(defs.length, 1);
    const definition = defs[0] as {
      name: string;
      execute(args: unknown): Promise<{
        recallId: string;
        text: string | null;
        byteLength: number;
        parts: Array<{ nodeId: string; text: string }>;
      }>;
    };
    assert.equal(definition.name, "recall");
    const restored = await definition.execute({ id: workerRecallId });
    assert.equal(restored.recallId, workerRecallId);
    assert.equal(restored.text, worker.body, "the worker's recall restores its own bytes");
    assert.equal(restored.byteLength, Buffer.byteLength(worker.body, "utf8"));
    assert.equal(restored.parts.length, 1);
    // The worker id is the ledger boundary: the parent's archive is a miss.
    await assert.rejects(
      () => definition.execute({ id: parentRecallId }),
      /Missing recall|not-found|Invalid recall id/u,
      "the worker's recall refuses the parent session's id",
    );
    // Registering the definitions on a scope returns the exact unregister.
    const registered: unknown[] = [];
    const dispose = mount.recallTools(
      { register: (value: unknown) => { registered.push(value); return () => { registered.length = 0; }; } },
      worker.id,
    );
    assert.equal(registered.length, 1, "one definition registered on the surface");
    dispose();
    assert.equal(registered.length, 0, "the unregister removes exactly that definition");
  });
});

// ── 4. config mapping ─────────────────────────────────────────────────────
//
// Behaviour-change note retained here as a comment rather than a test (ticket
// 172): at upstream `70c99ef` the judge's `settleVerdicts` read
// `protocol.enforcement === 'record-only'` and dropped the batch, so
// `racoonsRecordOnly: true` really did mean "no context edits". At the pinned
// `b5f95cb` the judge is gone (ADR-0028) and `enforcement` is checked in only
// two places — `settlePrune` and `settleForget` — neither on the
// entry-checkpoint path. The entry apply runs whatever the mode says. If
// dsh-bot wants "record-only means no context edits" to stay true (its
// settings card and README both say so), the mount must gate the entry apply
// itself; until then the vendored library decides.

// ── 5. teardown ───────────────────────────────────────────────────────────

describe("ticket 145 — teardown", () => {
  it("dispose closes every cached ledger and removes every listener; remount is clean", async (t) => {
    const root = scratchRoot();
    const journal = captureJournal();
    t.after(journal.restore);

    const ctx = createMountCtx({ llm: cannedLlm(FORGET_ALL_ANSWER) });
    const baselines = new Map<string, number>();
    const events = ["session/event", "llm/stream", "agent/pre-step", "agent/turn-stopping"];
    for (const name of events) baselines.set(name, ctx.listenerCount(name));
    assert.deepEqual(
      events.map((name) => ctx.listenerCount(name)),
      [0, 0, 0, 0],
      "the bare context starts with no listeners",
    );

    const mount = mountSession(ctx, root);
    const first = fakeSession("sess-teardown-a");
    const second = fakeSession("sess-teardown-b");
    attachSession(first, ctx);
    attachSession(second, ctx);
    await cappingPass(ctx, first, "c-t1", oversizedBody(40 * 1024, "TEAR-A"));
    // The second session reaches a boundary too, but its result stays below
    // the bar, so it only OPENS a ledger (the cache teardown must close).
    await sendMainWire(ctx, second.id);
    scriptStep(second, {
      turn: 1,
      step: 1,
      toolCall: { id: "c-t2", name: "read", input: { file_path: "small.txt" } },
      result: { content: [{ type: "text", text: "small" }] },
      endTurn: true,
    });
    await runStep(ctx, second, 1, 2);

    for (const name of events) {
      assert.equal(ctx.listenerCount(name), baselines.get(name)! + 1, `${name} registered once`);
    }
    const ledgers = [
      mount.ledgerOf("sess-teardown-a"),
      mount.ledgerOf("sess-teardown-b"),
    ];

    const disposing = mount.dispose();
    await disposing;
    // Idempotent: a second dispose answers the same settled promise.
    assert.equal(mount.dispose(), disposing);
    await mount.dispose();
    await flush();

    for (const name of events) {
      assert.equal(ctx.listenerCount(name), baselines.get(name), `${name} released at dispose`);
    }
    // Every cached ledger is closed, and the mount no longer hands one out.
    for (const ledger of ledgers) {
      await assert.rejects(
        () => ledger.recall(`recall:sha256:${"0".repeat(64)}` as never),
        /closed/u,
        "dispose closed the ledger",
      );
    }
    assert.throws(() => mount.ledgerOf("sess-teardown-a"), /no ledger is open/u);
    await assert.rejects(
      () => mount.ledgerFor("sess-teardown-c"),
      /disposed/u,
      "a disposed mount never opens a new ledger",
    );

    // No listener survives, so boundary events are inert rather than errors.
    // (Nothing calls `next` here: with no listener there is no waterfall to
    // continue, which is exactly the host behaviour a released listener leaves.)
    const late = fakeSession("sess-teardown-late");
    attachSession(late, ctx);
    await assert.doesNotReject(async () => {
      await ctx.fire("llm/stream", mainWire(late.id), () => emptyStream());
      scriptStep(late, { turn: 1, step: 1, endTurn: true });
      await runStep(ctx, late, 1, 2);
    });
    assert.equal(replacementEvents(late).length, 0);

    // Remounting on the same live context is clean: listeners return, a pass
    // runs, and its ledger is fresh (the disposed cache is not shared).
    journal.reset();
    const remount = mountSession(ctx, root);
    const resumed = fakeSession("sess-teardown-late");
    attachSession(resumed, ctx);
    await cappingPass(ctx, resumed, "c-t3", oversizedBody(40 * 1024, "TEAR-C"));
    assert.equal(ctx.listenerCount("agent/pre-step"), baselines.get("agent/pre-step")! + 1);
    assert.equal(replacementEvents(resumed).length, 1, "the remounted pass applies");
    await remount.dispose();
    await flush();
    for (const name of events) {
      assert.equal(ctx.listenerCount(name), baselines.get(name), `${name} released by remount`);
    }
  });
});

// ── 6. journal privacy: metadata by default, full text only on opt-in ─────

describe("ticket 145 — journal sink privacy (second-round audit)", () => {
  const publishRecord = {
    kind: "publish",
    atMs: 10,
    sessionId: "sess-journal",
    replacements: [
      { nodeId: "n-1", byteLength: 30, text: "REWRITTEN CONTEXT SECRET" },
    ],
    appendRecords: [
      { recordId: "r-1", byteLength: 20, text: "APPENDED CONTEXT SECRET" },
    ],
    archives: [{ recallId: "recall:sha256:abc", title: "kept" }],
  } as const;

  const askRecord = {
    kind: "entry-ask",
    atMs: 11,
    sessionId: "sess-journal",
    action: "keepall",
    raw: 'RAW MODEL ANSWER SECRET',
    unitId: "u-1",
  } as const;

  it("the default sink emits metadata only: no rewritten text, no raw output", () => {
    const lines: string[] = [];
    const sink = createJournalSink((line) => lines.push(line));
    sink(publishRecord as never);
    sink(askRecord as never);
    const joined = lines.join("\n");
    assert.ok(lines.length === 2);
    assert.ok(!joined.includes("REWRITTEN CONTEXT SECRET"));
    assert.ok(!joined.includes("APPENDED CONTEXT SECRET"));
    assert.ok(!joined.includes("RAW MODEL ANSWER SECRET"));
    // Metadata that the live gate reads survives.
    assert.ok(joined.includes("recall:sha256:abc"));
    assert.ok(joined.includes("n-1"));
    assert.ok(joined.includes("keepall"));
    assert.ok(joined.includes("u-1"));
  });

  it("the shipped default console sink never logs prompt text", (t) => {
    const lines: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.map((value) => String(value)).join(" "));
    };
    t.after(() => {
      console.info = original;
    });
    // Default sink AND default write function.
    const sink = createJournalSink();
    sink(publishRecord as never);
    sink(askRecord as never);
    const joined = lines.join("\n");
    assert.ok(joined.startsWith("racoons: publish"));
    assert.ok(!joined.includes("REWRITTEN CONTEXT SECRET"));
    assert.ok(!joined.includes("APPENDED CONTEXT SECRET"));
    assert.ok(!joined.includes("RAW MODEL ANSWER SECRET"));
  });

  it("full text is available behind an explicit debug opt-in", () => {
    const lines: string[] = [];
    const sink = createJournalSink((line) => lines.push(line), {
      includeText: true,
    });
    sink(publishRecord as never);
    sink(askRecord as never);
    const joined = lines.join("\n");
    assert.ok(joined.includes("REWRITTEN CONTEXT SECRET"));
    assert.ok(joined.includes("APPENDED CONTEXT SECRET"));
    assert.ok(joined.includes("RAW MODEL ANSWER SECRET"));
  });

  it("the environment variable is the explicit process-level opt-in", (t) => {
    const previous = process.env[RACOONS_JOURNAL_FULL_TEXT_ENV];
    process.env[RACOONS_JOURNAL_FULL_TEXT_ENV] = "1";
    t.after(() => {
      if (previous === undefined) delete process.env[RACOONS_JOURNAL_FULL_TEXT_ENV];
      else process.env[RACOONS_JOURNAL_FULL_TEXT_ENV] = previous;
    });
    const lines: string[] = [];
    createJournalSink((line) => lines.push(line))(askRecord as never);
    assert.ok(lines.join("\n").includes("RAW MODEL ANSWER SECRET"));
  });
});
