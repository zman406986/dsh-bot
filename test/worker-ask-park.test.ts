/**
 * Ticket 69 — the park-vs-settlement fix (live FINDING 4, ticket 33
 * Session B-4 record).
 *
 * Live B-4: a worker called `request_access` once, the tool returned the
 * park ack in 46 ms, the worker ended its turn per the W19 contract, dsh
 * settled the turn, and the core's settle path dropped the pending ticket
 * ("Settle wins over a pending access ask") — the worker was marked
 * completed+delivered ~6 s after spawn, `pendingAsks` stayed empty, no card
 * rendered, and the resolve command honestly found nothing. The stop-and-
 * wait contract and dsh settlement semantics conflicted: the relay's park
 * never got a window.
 *
 * The fix parks the TOOL CALL, not the turn-end: `awaitSettled` holds
 * execute open while the ask sits in the relay, the worker's turn cannot
 * finish mid-tool-call, and settlement cannot eat the ask. These pins drive
 * the handler with the SAME dep shape the plugin wires
 * (`createPendingAskSettleWaiter` over the relay's pending list) plus the
 * grep-level wiring pin for the apply() line (the dispatch-approval idiom —
 * behavior pins cannot see inside apply()).
 *
 * Offline only (S8): FakeDshHost, injected delays, no network, no LLM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import {
  ASK_SETTLED_SUMMARY,
  createPendingAskSettleWaiter,
  createRequestAccessHandler,
} from "../src/adapter/worker-access-tool.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask } from "../src/core/multitask.js";

/** Real delay, kept tiny; the rig's waiter polls at 10 ms. */
const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The rig: a real core over a FakeDshHost, one spawned + running worker,
 * and the request_access handler built with the plugin's dep shape (the
 * same lambda backs the duplicate-ask refusal and the settle waiter).
 */
async function rig(access?: { timeoutMs: number }) {
  const host = new FakeDshHost();
  const multitask = createMultitask(
    host,
    access !== undefined ? { access } : undefined,
  );
  const spawned = await multitask.spawnWorker({
    parentSessionId: "s-1",
    streamKey: "k-1",
    title: "Park probe worker",
    prompt: "Ask for access, then hold.",
  });
  assert.ok(spawned.ok);
  if (!spawned.ok) throw new Error("unreachable");
  const workerId = spawned.workerId;
  multitask.noteTurnStarted(workerId);

  const pendingAskOf = (id: string): boolean =>
    multitask.listPendingAccess().some((t) => t.workerId === id);
  const execute = createRequestAccessHandler({
    resolveWorkerId: (exec) => {
      const record = exec as { sessionId?: unknown } | null | undefined;
      return record?.sessionId != null ? String(record.sessionId) : null;
    },
    hasPendingAsk: pendingAskOf,
    emit: (event) => {
      host.fireAccessRequest(event);
    },
    awaitSettled: createPendingAskSettleWaiter({
      isPending: pendingAskOf,
      pollMs: 10,
    }),
  });

  /**
   * Call the tool the way the host does (no await) and observe whether the
   * call has settled — the park assertion reads this flag.
   */
  const call = (args: Record<string, unknown>) => {
    const state = { settled: false };
    const promise = execute(args, { sessionId: workerId }).then(
      (result) => {
        state.settled = true;
        return result as { ok: boolean; summary: string; requestId?: string };
      },
    );
    return { state, promise };
  };

  return { host, multitask, execute, workerId, call, pendingAskOf };
}

const ASK_ARGS = {
  class: "tool",
  target: "edit_file",
  reason: "need to edit files",
};

describe("ticket 69 / FINDING 4 — request_access parks the tool call, not the turn-end", () => {
  it("execute stays pending while the ask is parked; a racing host settle cannot eat the ask silently — it settles the tool honestly", async () => {
    // The B-4 repro: the worker asked, and (old world) the tool acked at
    // once, the turn ended, and the settle fired while the ask was parked —
    // silently destroying it. Here the tool is STILL pending when the
    // settle arrives, so the settle becomes an honest cancellation instead
    // of a lost ask.
    const { host, multitask, workerId, call } = await rig();
    const { state, promise } = call(ASK_ARGS);
    await delay(40);
    assert.equal(
      state.settled,
      false,
      "the tool call must stay parked while the ask is pending (old code acked at park time)",
    );
    assert.equal(multitask.listPendingAccess().length, 1);

    // The host settles the worker's turn anyway (e.g. a stop raced in).
    host.fireSettled({
      workerId,
      status: "completed",
      report: "ended its turn per the contract",
    });
    const result = await promise; // the await settling IS the no-wedge pin
    assert.equal(result.ok, true);
    assert.equal(result.summary, ASK_SETTLED_SUMMARY);
    assert.equal(multitask.listPendingAccess().length, 0);
  });

  it("an explicit resolve unblocks the parked tool and the decision reaches the worker", async () => {
    const { host, multitask, workerId, call } = await rig();
    const { state, promise } = call(ASK_ARGS);
    await delay(40);
    assert.equal(state.settled, false);
    assert.equal(multitask.listPendingAccess().length, 1);

    assert.equal(
      multitask.resolveAccess(workerId, { kind: "allow" }),
      true,
      "the ask is still pending for the resolver — the park held",
    );
    const result = await promise;
    assert.equal(result.ok, true);
    assert.equal(result.summary, ASK_SETTLED_SUMMARY);
    assert.equal(multitask.listPendingAccess().length, 0);
    // The wrapped decision still rides the relay's deliver path — the tool
    // result names the settle; the message carries the decision itself.
    assert.ok(
      host.sendMessageCalls.some(
        (sent) =>
          sent.workerId === workerId &&
          sent.message.includes("[Parent: access allowed]"),
      ),
      "the decision reached the worker as its next message",
    );
  });

  it("the armed ADR-0008 timeout bounds the block: the tool settles on the deny", async () => {
    const { host, multitask, call } = await rig({ timeoutMs: 30 });
    const { promise } = call(ASK_ARGS);
    const result = await promise; // bounded by the relay's armed timeout
    assert.equal(result.ok, true);
    assert.equal(result.summary, ASK_SETTLED_SUMMARY);
    assert.equal(multitask.listPendingAccess().length, 0);
    assert.ok(
      host.sendMessageCalls.some((sent) => sent.message.includes("timed out")),
      "the timeout deny was delivered to the worker",
    );
  });

  it("stop wins: aborting the worker settles the parked tool — never a wedge", async () => {
    const { multitask, workerId, call } = await rig();
    const { state, promise } = call(ASK_ARGS);
    await delay(40);
    assert.equal(state.settled, false);
    await multitask.abortWorker(workerId);
    const result = await promise;
    assert.equal(result.ok, true);
    assert.equal(result.summary, ASK_SETTLED_SUMMARY);
    assert.equal(multitask.listPendingAccess().length, 0);
  });

  it("the settle waiter polls core truth until the ask leaves the pending set", async () => {
    let pending = true;
    const delays: number[] = [];
    const waiter = createPendingAskSettleWaiter({
      isPending: () => pending,
      delay: async (ms) => {
        delays.push(ms);
        pending = false;
      },
    });
    await waiter("w-1", "req-1");
    assert.deepEqual(delays, [100], "one managed delay per pending poll");
  });

  it("without awaitSettled the legacy park-ack shape is kept (pure-handler callers)", async () => {
    const emitted: string[] = [];
    const execute = createRequestAccessHandler({
      resolveWorkerId: () => "w-legacy",
      hasPendingAsk: () => false,
      emit: (event) => {
        emitted.push(event.requestId);
      },
    });
    const result = (await execute(ASK_ARGS, { sessionId: "w-legacy" })) as {
      ok: boolean;
      summary: string;
    };
    assert.equal(result.ok, true);
    assert.match(result.summary, /Access request sent to the parent/);
    assert.equal(emitted.length, 1);
  });

  it("the apply() tool surface actually wires the settle waiter (source-level wiring pin)", () => {
    // The behavior pins above drive the handler with the plugin's dep shape
    // directly, so they cannot see the deps line inside apply(). This is the
    // grep-level review assertion for that line (composition-polish idiom:
    // source read, comments stripped, exact wiring expression asserted).
    const raw = readFileSync(
      new URL("../src/plugin.ts", import.meta.url),
      "utf8",
    );
    const withoutComments = raw
      .replace(/\r\n/g, "\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    assert.ok(
      withoutComments.includes(
        "awaitSettled: createPendingAskSettleWaiter({\n          isPending: pendingAskOf,\n        })",
      ),
      "acquireGlobalAccessTool must wire the FINDING 4 settle waiter " +
        "(dropped or replaced wiring must fail here)",
    );
    assert.ok(
      withoutComments.includes("hasPendingAsk: pendingAskOf"),
      "the duplicate-ask refusal and the settle waiter must read the SAME " +
        "pending-set truth",
    );
  });
});
