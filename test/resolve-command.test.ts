/**
 * Ticket 69 — L1 offline half: the resolve TRANSPORT.
 *
 * Host side: the `/dispatcher-resolve` command (the wrapper approval-card
 * buttons' egress). Its handler must gate on the INVOKING chat's own
 * dispatcher activation (ADR-0019), scope the ask to that session, route
 * the decision into the UNCHANGED relay entry point (`Multitask.resolveAccess`
 * — the same one the ticket-23 prompt pump uses), and honour ticket 30's
 * wildcard fence on the always-allow path. Client side: the seat helper
 * builds the exact command line and maps transport outcomes honestly.
 *
 * Integration: a REAL Multitask over FakeDshHost — a parked ask answered
 * through the command reaches the worker as the wrapped decision and
 * clears from `listPendingAccess`.
 *
 * Offline only (S8): FakeDshHost, no real timers armed beyond the relay's
 * injected-free defaults (timeout is 120s of wall clock it never reaches —
 * the test resolves first and clears the rest).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDispatcherResolveCommand,
  DISPATCHER_RESOLVE_COMMAND,
  DISPATCHER_RESOLVE_DENY_DETAIL,
  DISPATCHER_RESOLVE_DESCRIPTION,
  DISPATCHER_RESOLVE_INPUT_HINT,
  DISPATCHER_RESOLVE_NOT_ACTIVE,
  DISPATCHER_RESOLVE_NOT_DISPATCHER,
  DISPATCHER_RESOLVE_USAGE,
  dispatcherResolveNoPendingAsk,
  dispatcherResolveSettled,
  dispatcherResolveSuccess,
  parseResolveInput,
  type RegisterDispatcherResolveCommandOptions,
} from "../src/adapter/resolve-command.js";
import { isWildcardAccessTarget } from "../src/adapter/access-prompt.js";
import { submitAccessResolve } from "../src/client/actions.js";
import {
  createApprovalCardsStore,
  type AccessAskCard,
} from "../src/client/approval-cards.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask } from "../src/core/multitask.js";
import type {
  AccessDecision,
  AccessTicket,
} from "../src/core/access-types.js";
import type { CommandResultLike } from "../src/adapter/cordis-dsh-host.js";

describe("parseResolveInput (grammar)", () => {
  it("parses worker id + the three choice tokens", () => {
    assert.deepEqual(parseResolveInput("w-1 allow"), {
      workerId: "w-1",
      choice: "allow",
    });
    assert.deepEqual(parseResolveInput("w-1 always-allow"), {
      workerId: "w-1",
      choice: "always-allow",
    });
    assert.deepEqual(parseResolveInput("w-1 deny"), {
      workerId: "w-1",
      choice: "deny",
    });
  });

  it("refuses malformed, empty, or out-of-vocabulary input", () => {
    assert.equal(parseResolveInput(undefined), null);
    assert.equal(parseResolveInput(""), null);
    assert.equal(parseResolveInput("w-1"), null);
    assert.equal(parseResolveInput("w-1 maybe"), null);
    assert.equal(parseResolveInput("allow"), null);
  });
});

describe("dispatcher-resolve handler (command matrix)", () => {
  const TICKET: AccessTicket = {
    workerId: "w-1",
    requestId: "req-1",
    body: {
      class: "tool",
      target: "run_tests",
      reason: "needs to run the test suite",
    },
    createdAtMs: 1000,
    parentSessionId: "session-1",
    status: "pending",
  };

  interface Harness {
    readonly result: (rawInput: string, sessionId?: string) => CommandResultLike;
    readonly resolved: Array<{ workerId: string; decision: AccessDecision }>;
    readonly alwaysRows: Array<AccessTicket>;
    readonly lookedUpSessions: Array<string>;
  }

  function harness(options?: {
    pending?: AccessTicket | undefined;
    resolveReturns?: boolean;
  }): Harness {
    const resolved: Array<{ workerId: string; decision: AccessDecision }> = [];
    const alwaysRows: Array<AccessTicket> = [];
    const lookedUpSessions: Array<string> = [];
    const options_: RegisterDispatcherResolveCommandOptions = {
      ctx: {} as never, // unused by createDispatcherResolveCommand's handler
      activeSessionIds: () => ["session-1"],
      findPending: (workerId, parentSessionId) => {
        lookedUpSessions.push(parentSessionId);
        if (options?.pending === undefined) return undefined;
        if (options.pending.workerId !== workerId) return undefined;
        return options.pending;
      },
      resolve: (workerId, decision) => {
        resolved.push({ workerId, decision });
        return options?.resolveReturns ?? true;
      },
      alwaysAllow: (ticket) => {
        alwaysRows.push(ticket);
      },
      isWildcardTarget: isWildcardAccessTarget,
    };
    const command = createDispatcherResolveCommand(options_);
    return {
      result: (rawInput, sessionId = "session-1") =>
        command.handler({
          agent: { session: { id: sessionId } },
          rawInput,
        } as never) as CommandResultLike,
      resolved,
      alwaysRows,
      lookedUpSessions,
    };
  }

  it("refuses when no dispatcher is active or the chat is not the dispatcher", () => {
    const inactive = createDispatcherResolveCommand({
      ...harnessBase(),
      activeSessionIds: () => [],
    });
    assert.deepEqual(inactive.handler({ agent: { session: { id: "s" } } } as never), {
      kind: "error",
      text: DISPATCHER_RESOLVE_NOT_ACTIVE,
    });

    const h = harness({ pending: TICKET });
    const result = h.result("w-1 allow", "other-chat");
    assert.deepEqual(result, {
      kind: "error",
      text: DISPATCHER_RESOLVE_NOT_DISPATCHER,
    });
    assert.equal(h.resolved.length, 0);
  });

  it("refuses malformed input with usage copy", () => {
    const h = harness({ pending: TICKET });
    assert.deepEqual(h.result("w-1"), { kind: "error", text: DISPATCHER_RESOLVE_USAGE });
    assert.equal(h.resolved.length, 0);
  });

  it("refuses when no pending ask matches in the INVOKING session", () => {
    const h = harness({ pending: undefined });
    const result = h.result("w-1 allow");
    assert.deepEqual(result, {
      kind: "error",
      text: dispatcherResolveNoPendingAsk("w-1"),
    });
    // The lookup was scoped to the invoking session (ADR-0019 fence).
    assert.deepEqual(h.lookedUpSessions, ["session-1"]);
    assert.equal(h.resolved.length, 0);
  });

  it("allow routes the plain allow decision into the relay", () => {
    const h = harness({ pending: TICKET });
    assert.deepEqual(h.result("w-1 allow"), {
      kind: "success",
      text: dispatcherResolveSuccess("w-1"),
    });
    assert.deepEqual(h.resolved, [{ workerId: "w-1", decision: { kind: "allow" } }]);
    assert.equal(h.alwaysRows.length, 0);
  });

  it("deny routes a user-denied decision naming the input path", () => {
    const h = harness({ pending: TICKET });
    assert.ok(h.result("w-1 deny").kind === "success");
    assert.deepEqual(h.resolved, [
      {
        workerId: "w-1",
        decision: {
          kind: "deny",
          reason: "user-denied",
          detail: DISPATCHER_RESOLVE_DENY_DETAIL,
        },
      },
    ]);
  });

  it("always-allow inserts the session-scope row, then routes the allow", () => {
    const h = harness({ pending: TICKET });
    assert.ok(h.result("w-1 always-allow").kind === "success");
    assert.deepEqual(h.alwaysRows, [TICKET]);
    assert.deepEqual(h.resolved, [{ workerId: "w-1", decision: { kind: "allow" } }]);
  });

  it("the wildcard fence: an always-allow for a '*' target degrades to a plain allow", () => {
    const wildcard: AccessTicket = {
      ...TICKET,
      body: { class: "tool", target: "deploy*", reason: "r" },
    };
    const h = harness({ pending: wildcard });
    assert.ok(h.result("w-1 always-allow").kind === "success");
    assert.equal(h.alwaysRows.length, 0, "no '*' pattern may be remembered");
    assert.deepEqual(h.resolved, [{ workerId: "w-1", decision: { kind: "allow" } }]);
  });

  it("a false resolve (already settled / ADR-0008 timeout deny) is honest, never fake success", () => {
    const h = harness({ pending: TICKET, resolveReturns: false });
    assert.deepEqual(h.result("w-1 allow"), {
      kind: "error",
      text: dispatcherResolveSettled("w-1"),
    });
  });

  it("the command advertises its name, description, and input hint", () => {
    const command = createDispatcherResolveCommand({
      ...harnessBase(),
    });
    assert.equal(command.name, DISPATCHER_RESOLVE_COMMAND);
    assert.equal(command.name, "dispatcher-resolve");
    assert.equal(command.description, DISPATCHER_RESOLVE_DESCRIPTION);
    assert.deepEqual(command.input, { hint: DISPATCHER_RESOLVE_INPUT_HINT });
  });

  function harnessBase(): RegisterDispatcherResolveCommandOptions {
    return {
      ctx: {} as never,
      activeSessionIds: () => ["session-1"],
      findPending: () => undefined,
      resolve: () => true,
      alwaysAllow: () => {},
      isWildcardTarget: isWildcardAccessTarget,
    };
  }
});

describe("client seat helper (submitAccessResolve)", () => {
  function card(overrides: Partial<AccessAskCard> = {}): AccessAskCard {
    return {
      cardKind: "access-ask",
      requestId: "req-1",
      workerId: "w-1",
      workerTitle: "w-1",
      body: { class: "tool", target: "run_tests", reason: "r" },
      parentSessionId: "session-1",
      createdAtMs: 1000,
      status: "pending",
      optionSet: [],
      locationLine: "Runs on your computer.",
      detail: "r",
      ...overrides,
    };
  }

  it("sends the exact command line to the card's OWN parent session", async () => {
    const sent: Array<{ sessionId: string; line: string }> = [];
    const transport = {
      sendCommand: async (sessionId: string, line: string) => {
        sent.push({ sessionId, line });
        return { kind: "executed" } as const;
      },
      sendPrompt: async () => ({ kind: "sent" }) as const,
    };
    const outcome = await submitAccessResolve(transport, card(), "always-allow");
    assert.deepEqual(outcome, { kind: "routed" });
    assert.deepEqual(sent, [
      {
        sessionId: "session-1",
        line: "/dispatcher-resolve w-1 always-allow",
      },
    ]);
  });

  it("unresolved (no such command here) and no-channel both degrade honestly", async () => {
    const transport = {
      sendCommand: async () => ({ kind: "unresolved" }) as const,
      sendPrompt: async () => ({ kind: "sent" }) as const,
    };
    assert.deepEqual(await submitAccessResolve(transport, card(), "deny"), {
      kind: "no-channel",
    });
    const dead = {
      sendCommand: async () => ({ kind: "no-channel" }) as const,
      sendPrompt: async () => ({ kind: "sent" }) as const,
    };
    assert.deepEqual(await submitAccessResolve(dead, card(), "deny"), {
      kind: "no-channel",
    });
  });

  it("a transport rejection is an honest failure; a parentless card never sends", async () => {
    const boom = {
      sendCommand: async () => {
        throw new Error("down");
      },
      sendPrompt: async () => ({ kind: "sent" }) as const,
    };
    assert.deepEqual(await submitAccessResolve(boom, card(), "deny"), {
      kind: "failed",
    });
    const orphan = {
      sendCommand: async () => ({ kind: "executed" }) as const,
      sendPrompt: async () => ({ kind: "sent" }) as const,
    };
    assert.deepEqual(
      await submitAccessResolve(orphan, card({ parentSessionId: "" }), "deny"),
      { kind: "no-channel" },
    );
  });
});

describe("integration: command answer reaches the real relay (FakeDshHost)", () => {
  it("an allow through /dispatcher-resolve delivers the wrapped decision and clears the ticket", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host, {
      access: {
        timeoutMs: 3_600_000, // far beyond the test; nothing arms against it
      },
    });
    const spawn = await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "s-1",
      title: "Summarize RFCs",
      prompt: "Read and summarize.",
    });
    assert.ok(spawn.ok);
    if (!spawn.ok) return;

    // Park a real pending ask through the host → core seam.
    host.fireAccessRequest({
      kind: "access-request",
      workerId: spawn.workerId,
      requestId: "req-77",
      body: {
        class: "tool",
        target: "run_tests",
        reason: "needs the suite",
      },
      createdAtMs: 1000,
    });
    assert.equal(multitask.listPendingAccess("session-1").length, 1);

    let commandResult: CommandResultLike | undefined;
    let command: ReturnType<typeof createDispatcherResolveCommand>;
    {
      const options: RegisterDispatcherResolveCommandOptions = {
        ctx: {} as never,
        activeSessionIds: () => ["session-1"],
        findPending: (workerId, parentSessionId) =>
          multitask
            .listPendingAccess(parentSessionId)
            .find((t) => t.workerId === workerId),
        resolve: (workerId, decision) =>
          multitask.resolveAccess(workerId, decision),
        alwaysAllow: (ticket) => {
          if (isWildcardAccessTarget(ticket.body.target)) return;
          multitask.accessPolicy.set({
            class: ticket.body.class,
            targetPattern: ticket.body.target,
            decision: "allow",
            scope: "session",
            session: ticket.parentSessionId,
          });
        },
        isWildcardTarget: isWildcardAccessTarget,
      };
      command = createDispatcherResolveCommand(options);
      commandResult = command.handler({
        agent: { session: { id: "session-1" } },
        rawInput: `${spawn.workerId} allow`,
      } as never) as CommandResultLike;
    }
    assert.equal(commandResult.kind, "success");
    assert.equal(multitask.listPendingAccess("session-1").length, 0);
    // The decision reached the worker as the relay's wrapped allow note.
    const delivered = host.sendMessageCalls.find(
      (call) => call.workerId === spawn.workerId,
    );
    assert.ok(delivered);
    assert.ok(delivered.message.includes("[Parent: access allowed]"));
    // The session-scope row was remembered for THIS session's future asks.
    assert.equal(multitask.accessPolicy.list().length, 0, "plain allow writes no row");

    // Answering again after settle is honestly refused (ticket gone): the
    // command still exists, the ask does not — the no-pending-ask refusal,
    // never a fabricated second success.
    const again = command.handler({
      agent: { session: { id: "session-1" } },
      rawInput: `${spawn.workerId} allow`,
    } as never) as CommandResultLike;
    assert.deepEqual(again, {
      kind: "error",
      text: dispatcherResolveNoPendingAsk(spawn.workerId),
    });

    // A fresh ask parks and settles directly, so nothing is left pending (and
    // the relay's armed timeout is cleared) when the test ends.
    host.fireAccessRequest({
      kind: "access-request",
      workerId: spawn.workerId,
      requestId: "req-78",
      body: { class: "tool", target: "lint", reason: "r" },
      createdAtMs: 2000,
    });
    assert.equal(multitask.listPendingAccess("session-1").length, 1);
    multitask.resolveAccess(spawn.workerId, { kind: "allow" });
    multitask.clearSessionAccessPolicy("session-1");
  });
});

// The fed-store end-to-end (the seat's counterpart) lives in
// test/approval-feed.test.ts: unfed → ask appears → resolve (re-publish) →
// card leaves, plus the secret-ask variant and the expired path.
describe("store + seat sanity (the seat resolves nothing client-side)", () => {
  it("the store exposes no resolution API — answering is the seat's job", () => {
    const store = createApprovalCardsStore();
    assert.equal(typeof (store as never as Record<string, unknown>).resolve, "undefined");
    assert.equal(store.getBox().state.kind, "unfed");
  });
});
