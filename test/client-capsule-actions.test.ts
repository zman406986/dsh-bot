/**
 * Ticket 40 — capsule action wiring: the intents bound to ticket 36's
 * verified seams (epic 35 §2).
 *
 * Offline only (S8), all against INJECTED FAKES — no Cordis, no DOM, no
 * network, no host. The fake `CommandTransport` is the AC's guard proof:
 * the client's intents work end-to-end with a test double, so the transport
 * seam is the ONLY egress (no core/adapter import exists in the wiring
 * modules — asserted by a source scan).
 *
 * Asserted here:
 * - start submits the EXACT `/dispatcher-start` line through the composer's
 *   command transaction (`commands.execute(sessionId, line, [])`, ADR-0009);
 * - stop submits the conversational phrasing resolved from the LOCALE KEY
 *   `capsule.stop.message` (never a literal) through the plain-prompt sink;
 * - per-row steer prefills `/dispatcher-steer <workerId> ` (exact, trailing
 *   space) via `input.for(actx).setDraft`, with the copy-only fallback for
 *   every unreachable-face degrade branch;
 * - the failure path maps to honest error copy and flips NO state to
 *   "success" (no success outcome kind, no success copy key, `sent` is
 *   silent, and the roster/activation view models are never mutated by a
 *   send);
 * - the real transport binding (ticket 36 seam facts): `execute` resolves
 *   `undefined` → `unresolved` (the host runs nothing for an unresolvable
 *   line — why a conversational stop must NOT ride the command endpoint).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  CAPSULE_ACTION_NO_CHANNEL_KEY,
  CAPSULE_ACTION_NOT_AVAILABLE_KEY,
  CAPSULE_ACTION_SEND_FAILED_KEY,
  CAPSULE_STOP_MESSAGE_KEY,
  DISPATCHER_START_LINE,
  ROSTER_STEER_BUTTON_KEY,
  ROSTER_STEER_COPY_FALLBACK_KEY,
  ROSTER_STEER_HINT_KEY,
  activationOutcomeCopyKey,
  bindCommandTransport,
  createCapsuleActionStatus,
  sendActivationIntent,
  steerCommandPrefill,
  tryPrefillSteer,
  type ActivationSendOutcome,
  type CommandTransport,
} from "../src/client/actions.js";
import {
  describeCapsuleActivationRow,
  describeCapsuleChip,
} from "../src/client/capsule-store.js";
import type {
  ClientConversationLike,
  ClientRemoteLike,
  ClientSessionsLike,
} from "../src/client/context.js";
import {
  LOCALE_NAMESPACE,
  localeDictionary,
  validateLocaleDictionary,
} from "../src/client/overlay.js";
import { createRosterStore, type RosterPanelState } from "../src/client/roster-store.js";
import type { RosterSnapshot, RosterSnapshotWorker } from "../src/core/roster-snapshot.js";

/** Locale seat over the shipped en face (the same bind the module uses). */
const t = (key: string): string =>
  localeDictionary.en[key] ?? key;

/** A recording fake transport: captures every send verbatim. */
function fakeTransport(overrides: Partial<CommandTransport> = {}): {
  transport: CommandTransport;
  commands: Array<{ sessionId: string; line: string }>;
  prompts: Array<{ sessionId: string; text: string }>;
} {
  const commands: Array<{ sessionId: string; line: string }> = [];
  const prompts: Array<{ sessionId: string; text: string }> = [];
  const transport: CommandTransport = {
    async sendCommand(sessionId, line) {
      commands.push({ sessionId, line });
      return { kind: "executed" };
    },
    async sendPrompt(sessionId, text) {
      prompts.push({ sessionId, text });
      return { kind: "sent" };
    },
    ...overrides,
  };
  return { transport, commands, prompts };
}

/** A v2 snapshot with one running worker, for the no-mutation guard. */
function runningSnapshot(): RosterSnapshot {
  const worker: RosterSnapshotWorker = {
    kind: "worker",
    workerId: "w-1",
    title: "Worker w-1",
    status: "running",
    todoId: null,
    startedAtMs: 0,
    toolCallCount: 0,
    delivered: false,
    blocked: null,
  };
  return {
    schemaVersion: 2,
    dispatcherSessionId: "s-1",
    publishedAtMs: 1_000,
    workers: [worker],
  };
}

describe("capsule actions — command transport binding (ticket 36 seam 2)", () => {
  function fakeRemote(): {
    remote: ClientRemoteLike;
    calls: Array<{ sessionId: string; line: string; attachments: unknown[] }>;
  } {
    const calls: Array<{
      sessionId: string;
      line: string;
      attachments: unknown[];
    }> = [];
    const remote: ClientRemoteLike = {
      commands: {
        async execute(sessionId, line, attachments) {
          calls.push({ sessionId, line, attachments: [...attachments] });
          return { kind: "success" };
        },
      },
    };
    return { remote, calls };
  }

  it("sendCommand uses the composer's exact transaction: (sessionId, line, [])", async () => {
    const { remote, calls } = fakeRemote();
    const transport = bindCommandTransport({ remote: () => remote, sessions: () => undefined });
    const result = await transport.sendCommand("s-1", DISPATCHER_START_LINE);
    assert.deepEqual(calls, [
      { sessionId: "s-1", line: "/dispatcher-start", attachments: [] },
    ]);
    assert.deepEqual(result, { kind: "executed" });
  });

  it("an unresolvable line (host returns undefined) maps to unresolved, not executed", async () => {
    const { remote } = fakeRemote();
    remote.commands.execute = async () => undefined;
    const transport = bindCommandTransport({ remote: () => remote, sessions: () => undefined });
    assert.deepEqual(await transport.sendCommand("s-1", "/nope"), {
      kind: "unresolved",
    });
  });

  it("a missing remote face degrades to no-channel", async () => {
    const transport = bindCommandTransport({ remote: () => undefined, sessions: () => undefined });
    assert.deepEqual(await transport.sendCommand("s-1", DISPATCHER_START_LINE), {
      kind: "no-channel",
    });
  });

  it("sendPrompt addresses the plain-prompt sink via sessions.scope(id).conversation", async () => {
    const sent: string[] = [];
    const sessions: ClientSessionsLike = {
      list: { getSnapshot: () => ({ current: "s-1" }) },
      scope: (id) => ({
        conversation: {
          async send(text) {
            assert.equal(id, "s-1");
            sent.push(text);
          },
        },
      }),
    };
    const transport = bindCommandTransport({ remote: () => undefined, sessions: () => sessions });
    assert.deepEqual(await transport.sendPrompt("s-1", "please stop"), {
      kind: "sent",
    });
    assert.deepEqual(sent, ["please stop"]);
  });

  it("sendPrompt degrades to no-channel without sessions, scope, or sink", async () => {
    const noSessions = bindCommandTransport({
      remote: () => undefined,
      sessions: () => undefined,
    });
    assert.deepEqual(await noSessions.sendPrompt("s-1", "x"), { kind: "no-channel" });

    const noScope = bindCommandTransport({
      remote: () => undefined,
      sessions: () => ({
        list: { getSnapshot: () => ({ current: "s-1" }) },
        scope: () => undefined,
      }),
    });
    assert.deepEqual(await noScope.sendPrompt("s-1", "x"), { kind: "no-channel" });

    const noSink = bindCommandTransport({
      remote: () => undefined,
      sessions: () => ({
        list: { getSnapshot: () => ({ current: "s-1" }) },
        scope: () => ({}),
      }),
    });
    assert.deepEqual(await noSink.sendPrompt("s-1", "x"), { kind: "no-channel" });
  });
});

describe("capsule actions — activation intents through the fake transport", () => {
  it("start submits /dispatcher-start VERBATIM to the current session", async () => {
    const { transport, commands, prompts } = fakeTransport();
    const outcome = await sendActivationIntent(
      transport,
      () => "s-9",
      "start",
      t(CAPSULE_STOP_MESSAGE_KEY),
    );
    assert.deepEqual(commands, [{ sessionId: "s-9", line: "/dispatcher-start" }]);
    assert.deepEqual(prompts, []);
    assert.deepEqual(outcome, { kind: "sent" });
  });

  it("stop submits the conversational phrasing from the locale key — never a literal, never the command path", async () => {
    const { transport, commands, prompts } = fakeTransport();
    const stopMessage = t(CAPSULE_STOP_MESSAGE_KEY);
    assert.equal(stopMessage, localeDictionary.en["capsule.stop.message"]);
    const outcome = await sendActivationIntent(transport, () => "s-9", "stop", stopMessage);
    assert.deepEqual(prompts, [{ sessionId: "s-9", text: stopMessage }]);
    assert.deepEqual(commands, []);
    assert.deepEqual(outcome, { kind: "sent" });
  });

  it("no addressable current session → unavailable, transport untouched", async () => {
    const { transport, commands, prompts } = fakeTransport();
    const outcome = await sendActivationIntent(transport, () => undefined, "start", "x");
    assert.deepEqual(outcome, { kind: "unavailable" });
    assert.deepEqual(commands, []);
    assert.deepEqual(prompts, []);
  });

  it("no-channel results degrade to unavailable", async () => {
    const { transport } = fakeTransport({
      async sendCommand() {
        return { kind: "no-channel" };
      },
      async sendPrompt() {
        return { kind: "no-channel" };
      },
    });
    assert.deepEqual(await sendActivationIntent(transport, () => "s", "start", "x"), {
      kind: "unavailable",
    });
    assert.deepEqual(await sendActivationIntent(transport, () => "s", "stop", "x"), {
      kind: "unavailable",
    });
  });

  it("host resolves no command → unresolved (e.g. the flag is off here)", async () => {
    const { transport } = fakeTransport({
      async sendCommand() {
        return { kind: "unresolved" };
      },
    });
    assert.deepEqual(await sendActivationIntent(transport, () => "s", "start", "x"), {
      kind: "unresolved",
    });
  });

  it("a rejecting transport maps to failed — no throw escapes, no retry", async () => {
    const { transport } = fakeTransport({
      sendCommand: () => Promise.reject(new Error("wire down")),
      sendPrompt: () => Promise.reject(new Error("wire down")),
    });
    assert.deepEqual(await sendActivationIntent(transport, () => "s", "start", "x"), {
      kind: "failed",
    });
    assert.deepEqual(await sendActivationIntent(transport, () => "s", "stop", "x"), {
      kind: "failed",
    });
  });

  it("a send never mutates the roster/activation truth: no optimistic success", async () => {
    const store = createRosterStore();
    const fresh: RosterPanelState = {
      kind: "snapshot",
      snapshot: runningSnapshot(),
    };
    store.set(fresh);
    const before = describeCapsuleActivationRow(fresh, 1_000);
    const chipBefore = describeCapsuleChip(fresh, 1_000);

    const { transport } = fakeTransport();
    const outcomes: ActivationSendOutcome[] = [];
    outcomes.push(await sendActivationIntent(transport, () => "s", "start", "x"));
    outcomes.push(await sendActivationIntent(transport, () => "s", "stop", "x"));
    assert.deepEqual(outcomes, [{ kind: "sent" }, { kind: "sent" }]);

    // The same store state derives the exact same views — nothing flipped.
    assert.deepEqual(describeCapsuleActivationRow(fresh, 1_000), before);
    assert.deepEqual(describeCapsuleChip(fresh, 1_000), chipBefore);
    assert.deepEqual(store.getBox().state, fresh);
  });
});

describe("capsule actions — honest failure copy, no success state", () => {
  it("failed/unresolved/unavailable map to their error keys; sent maps to silence", () => {
    assert.equal(activationOutcomeCopyKey({ kind: "sent" }), null);
    assert.equal(
      activationOutcomeCopyKey({ kind: "failed" }),
      "capsule.action.send-failed",
    );
    assert.equal(
      activationOutcomeCopyKey({ kind: "unresolved" }),
      "capsule.action.not-available",
    );
    assert.equal(
      activationOutcomeCopyKey({ kind: "unavailable" }),
      "capsule.action.no-channel",
    );
  });

  it("the outcome vocabulary admits NO success copy in either face", () => {
    const outcomes: ActivationSendOutcome[] = [
      { kind: "sent" },
      { kind: "failed" },
      { kind: "unresolved" },
      { kind: "unavailable" },
    ];
    for (const outcome of outcomes) {
      const key = activationOutcomeCopyKey(outcome);
      if (key === null) continue;
      assert.match(key, /^capsule\.action\./);
      assert.doesNotMatch(key, /success|started|activated|done/i);
      // Every mapped key resolves to non-empty copy in BOTH faces.
      assert.ok(localeDictionary.en[key].length > 0, `en missing ${key}`);
      assert.ok(localeDictionary.zh[key].length > 0, `zh missing ${key}`);
    }
    // And the notice store can only ever carry one of those keys or null.
    const status = createCapsuleActionStatus();
    for (const outcome of outcomes) {
      status.set(activationOutcomeCopyKey(outcome));
      const carried = status.getBox().copyKey;
      assert.ok(
        carried === null ||
        carried === CAPSULE_ACTION_SEND_FAILED_KEY ||
        carried === CAPSULE_ACTION_NOT_AVAILABLE_KEY ||
        carried === CAPSULE_ACTION_NO_CHANNEL_KEY,
        `status box carries a non-vocabulary key: ${String(carried)}`,
      );
    }
  });

  it("the action-status store clears on the next attempt and never holds success", () => {
    const status = createCapsuleActionStatus();
    assert.deepEqual(status.getBox(), { copyKey: null, version: 0 });

    const seen: Array<string | null> = [];
    status.subscribe(() => seen.push(status.getBox().copyKey));

    status.set(CAPSULE_ACTION_SEND_FAILED_KEY);
    assert.equal(status.getBox().copyKey, CAPSULE_ACTION_SEND_FAILED_KEY);
    // Same value → no notify (box identity discipline).
    status.set(CAPSULE_ACTION_SEND_FAILED_KEY);
    status.set(null); // the binder clears at dispatch time
    assert.equal(status.getBox().copyKey, null);
    assert.deepEqual(seen, [CAPSULE_ACTION_SEND_FAILED_KEY, null]);
  });
});

describe("capsule actions — per-row steer prefill (ticket 36 seam 3)", () => {
  it("steerCommandPrefill is the exact-target power line with trailing space", () => {
    assert.equal(steerCommandPrefill("w-1"), "/dispatcher-steer w-1 ");
    assert.equal(steerCommandPrefill("worker-42"), "/dispatcher-steer worker-42 ");
  });

  function fakeSteerSources(): {
    sessions: ClientSessionsLike;
    conversation: ClientConversationLike;
    drafts: string[];
    actxSeen: unknown[];
  } {
    const drafts: string[] = [];
    const actxSeen: unknown[] = [];
    const sessions: ClientSessionsLike = {
      list: { getSnapshot: () => ({ current: "s-1" }) },
      scope: (id) => {
        assert.equal(id, "s-1");
        return { conversation: undefined };
      },
    };
    const conversation: ClientConversationLike = {
      input: {
        for(actx) {
          actxSeen.push(actx);
          return {
            setDraft(text) {
              drafts.push(text);
            },
          };
        },
      },
    };
    return { sessions, conversation, drafts, actxSeen };
  }

  it("prefills the composer draft with /dispatcher-steer <workerId> via input.for(actx).setDraft", () => {
    const { sessions, conversation, drafts, actxSeen } = fakeSteerSources();
    const scoped = sessions.scope("s-1");
    const outcome = tryPrefillSteer(
      { sessions: () => sessions, conversation: () => conversation },
      "w-3",
    );
    assert.deepEqual(outcome, { kind: "prefilled" });
    assert.deepEqual(drafts, ["/dispatcher-steer w-3 "]);
    // The exact scoped context from sessions.scope is what reaches the resolver.
    assert.deepEqual(actxSeen, [scoped]);
  });

  it("degrades to copy-only fallback for every unreachable face", () => {
    const { sessions, conversation } = fakeSteerSources();
    const cases: Array<{ label: string; sources: Parameters<typeof tryPrefillSteer>[0] }> = [
      {
        label: "no sessions service",
        sources: { sessions: () => undefined, conversation: () => conversation },
      },
      {
        label: "no conversation service",
        sources: { sessions: () => sessions, conversation: () => undefined },
      },
      {
        label: "no current session",
        sources: {
          sessions: () => ({
            list: { getSnapshot: () => ({ current: undefined }) },
            scope: () => undefined,
          }),
          conversation: () => conversation,
        },
      },
      {
        label: "scope resolves undefined",
        sources: {
          sessions: () => ({
            list: { getSnapshot: () => ({ current: "s-1" }) },
            scope: () => undefined,
          }),
          conversation: () => conversation,
        },
      },
      {
        label: "setDraft throws",
        sources: {
          sessions: () => sessions,
          conversation: () => ({
            input: {
              for: () => {
                throw new Error("busy admission phase");
              },
            },
          }),
        },
      },
    ];
    for (const { label, sources } of cases) {
      assert.deepEqual(
        tryPrefillSteer(sources, "w-1"),
        { kind: "unavailable" },
        `degrade case: ${label}`,
      );
    }
  });
});

describe("capsule actions — locale contract for the ticket-40 keys", () => {
  const NEW_KEYS = [
    CAPSULE_STOP_MESSAGE_KEY,
    CAPSULE_ACTION_SEND_FAILED_KEY,
    CAPSULE_ACTION_NOT_AVAILABLE_KEY,
    CAPSULE_ACTION_NO_CHANNEL_KEY,
    ROSTER_STEER_BUTTON_KEY,
    ROSTER_STEER_HINT_KEY,
    ROSTER_STEER_COPY_FALLBACK_KEY,
  ];

  it("every new key exists as non-empty copy in BOTH faces; validator green", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    for (const key of NEW_KEYS) {
      assert.ok(localeDictionary.en[key]?.length > 0, `en empty: ${key}`);
      assert.ok(localeDictionary.zh[key]?.length > 0, `zh empty: ${key}`);
    }
  });

  it("the steer hint and copy fallback carry the {workerId} placeholder; fallback names the command", () => {
    for (const key of [ROSTER_STEER_HINT_KEY, ROSTER_STEER_COPY_FALLBACK_KEY]) {
      assert.match(localeDictionary.en[key], /\{workerId\}/, key);
      assert.match(localeDictionary.zh[key], /\{workerId\}/, key);
    }
    assert.match(localeDictionary.en[ROSTER_STEER_COPY_FALLBACK_KEY], /\/dispatcher-steer/);
    assert.match(localeDictionary.zh[ROSTER_STEER_COPY_FALLBACK_KEY], /\/dispatcher-steer/);
  });

  it("the stop message is an ask, not a kill control phrasing", () => {
    assert.match(localeDictionary.en[CAPSULE_STOP_MESSAGE_KEY], /^[Pp]lease /);
    assert.match(localeDictionary.zh[CAPSULE_STOP_MESSAGE_KEY], /^请/);
  });
});

describe("capsule actions — egress guard: the transport is the only egress", () => {
  const read = (path: string): string =>
    readFileSync(new URL(path, import.meta.url), "utf8");

  it("the wiring modules import no core/adapter module", () => {
    for (const file of [
      "../src/client/actions.ts",
      "../src/client/index.ts",
    ]) {
      const source = read(file);
      assert.doesNotMatch(
        source,
        /from "\.\.\/(adapter|core)\//,
        `${file} must not import core/adapter internals`,
      );
    }
  });

  it("the client never touches the host-side steer/stop transports", () => {
    const source = read("../src/client/actions.ts");
    for (const banned of [
      "subagents",
      "sendMessage",
      "steerWorker",
      "stopWorker",
      "interruptWorker",
    ]) {
      assert.ok(
        !source.includes(banned),
        `actions.ts must not reference the host-side ${banned} transport`,
      );
    }
  });
});
