/**
 * Ticket 101 — the client add/delete dispatcher-session affordances
 * (ADR-0021 decision 3: dispatcher sessions can be added and deleted from
 * our UI; "delete" = deactivate the dispatcher binding, the chat itself is
 * never disposed; worker/turn management stays excluded — U-G amended for
 * dispatcher sessions ONLY).
 *
 * Offline only (S8), the repo's usual discipline:
 * - the pure decisions in `shell-store.ts` (add picker over the mirror
 *   authority; the delete armed-window confirmation) are driven directly;
 * - the REAL `mountShellPage` wiring is driven over a minimal client fake
 *   whose `remote.commands.execute` is a recorded spy (the ticket-36 seam-2
 *   transaction — the composer's exact command path), asserting the seats
 *   execute the right line in the right session and nothing else;
 * - the no-worker-stop posture is pinned structurally (no banned verb in
 *   the hosts' key set; the one egress transport carries exactly its two
 *   user-path methods).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeAddPicker,
  createDispatcherShellStore,
  SHELL_DELETE_CONFIRM_MS,
  SHELL_DELETE_IDLE,
  shellDeletePress,
  type ShellState,
} from "../src/client/shell-store.js";
import { mountShellPage } from "../src/client/index.js";
import {
  DISPATCHER_START_LINE,
  DISPATCHER_STOP_LINE,
  bindCommandTransport,
} from "../src/client/actions.js";
import type { ClientContext } from "../src/client/context.js";

/** Build a store state the way production feeds it (feed rows + mirrors). */
function stateOf(
  rows: ReadonlyArray<{
    sessionId: string;
    title: string;
    dispatcher?: boolean;
  }>,
  mirrorWrites: ReadonlyArray<{ sessionId: string; value: unknown }> = [],
): ShellState {
  const store = createDispatcherShellStore();
  for (const write of mirrorWrites) {
    store.applySessionMirror(write.sessionId, write.value);
  }
  store.upsertSessions(rows);
  return store.getBox().state;
}

describe("add picker — candidates from the mirror authority (ticket 101)", () => {
  it("lists the sessions the mirrors do not flag as dispatchers, in feed order", () => {
    const state = stateOf([
      { sessionId: "s-plain", title: "Plain chat" },
      { sessionId: "s-dispatch", title: "Dispatcher", dispatcher: true },
      { sessionId: "s-other", title: "Other chat" },
    ]);
    const picker = describeAddPicker(state);
    assert.equal(picker.kind, "ready");
    if (picker.kind === "ready") {
      assert.deepEqual(
        picker.candidates.map((row) => row.sessionId),
        ["s-plain", "s-other"],
        "the flagged dispatcher row is excluded; feed order is kept",
      );
    }
  });

  it("a cleared mirror (deactivation) makes the row addable again", () => {
    const state = stateOf(
      [{ sessionId: "s-1", title: "Former dispatcher" }],
      [{ sessionId: "s-1", value: null }],
    );
    const picker = describeAddPicker(state);
    assert.equal(picker.kind, "ready");
  });

  it("a mirror-flagged row is excluded even when the feed claim is absent", () => {
    // The flag comes from the mirrors; the feed's optional dispatcher claim
    // is only a seed. Flag via mirror, claim via feed — both exclude.
    const snapshot = {
      schemaVersion: 4,
      dispatcherSessionId: "s-live",
      publishedAtMs: 10_000,
      workers: [],
      recentResult: null,
      pendingAsks: [],
    };
    const state = stateOf(
      [{ sessionId: "s-live", title: "Live dispatcher" }],
      [{ sessionId: "s-live", value: snapshot }],
    );
    const picker = describeAddPicker(state);
    assert.equal(picker.kind, "empty");
  });

  it("no candidates at all is the honest empty state (never a fake creation)", () => {
    assert.equal(describeAddPicker(stateOf([])).kind, "empty");
    // Every known session is already a dispatcher: same honest empty.
    const state = stateOf([
      { sessionId: "s-1", title: "Dispatcher", dispatcher: true },
    ]);
    assert.equal(describeAddPicker(state).kind, "empty");
  });
});

describe("delete confirmation — the armed window (ticket 101)", () => {
  it("first press arms; a second press inside the window confirms and resets", () => {
    let state = SHELL_DELETE_IDLE;
    const first = shellDeletePress(state, "s-1", 1_000);
    assert.equal(first.action, "arm");
    assert.deepEqual(first.state, {
      armedSessionId: "s-1",
      armedAtMs: 1_000,
    });

    state = first.state;
    const second = shellDeletePress(state, "s-1", 1_000 + SHELL_DELETE_CONFIRM_MS);
    assert.equal(second.action, "confirm");
    assert.deepEqual(second.state, SHELL_DELETE_IDLE, "confirmed: disarm");
  });

  it("a press past the window does NOT confirm — it re-arms", () => {
    const armed = shellDeletePress(SHELL_DELETE_IDLE, "s-1", 1_000).state;
    const late = shellDeletePress(armed, "s-1", 1_000 + SHELL_DELETE_CONFIRM_MS + 1);
    assert.equal(late.action, "arm", "the window is a hard bound");
    assert.equal(late.state.armedSessionId, "s-1");
    assert.equal(late.state.armedAtMs, 1_000 + SHELL_DELETE_CONFIRM_MS + 1);
  });

  it("arming a second row moves the single arm slot; the first row cannot confirm", () => {
    const armedFirst = shellDeletePress(SHELL_DELETE_IDLE, "s-1", 1_000).state;
    const pressSecond = shellDeletePress(armedFirst, "s-2", 1_100);
    assert.equal(pressSecond.action, "arm");
    // The user returns to the first row and presses again within its window:
    // its arm was displaced, so this press is a fresh arm, never a confirm.
    const pressFirstAgain = shellDeletePress(pressSecond.state, "s-1", 1_500);
    assert.equal(pressFirstAgain.action, "arm");
    assert.equal(pressFirstAgain.state.armedSessionId, "s-1");
  });

  it("a clock anomaly (press before the arm moment) never confirms", () => {
    const armed = shellDeletePress(SHELL_DELETE_IDLE, "s-1", 5_000).state;
    const anomaly = shellDeletePress(armed, "s-1", 4_999);
    assert.equal(anomaly.action, "arm", "negative elapsed time cannot confirm");
  });
});

// ── The real mount wiring over a minimal client fake ───────────────────────

function createMountCtx() {
  const executed: Array<{
    sessionId: string;
    line: string;
    attachments: readonly unknown[];
  }> = [];
  let remoteMissing = false;
  const ctx = {
    effect(execute: () => unknown) {
      const returned = execute();
      void (typeof returned === "function" ? returned : () => {});
    },
    locale: {
      register() {
        return () => {};
      },
      bind() {
        return (key: string) => key;
      },
    },
    get remote() {
      if (remoteMissing) return undefined;
      return {
        commands: {
          execute(
            sessionId: string,
            line: string,
            attachments: readonly unknown[],
          ) {
            executed.push({ sessionId, line, attachments });
            return Promise.resolve({ kind: "success", text: "ok" });
          },
        },
      };
    },
    sessions: {
      list: {
        getSnapshot: () => ({ ids: [], byId: {} }),
      },
      scope: () => undefined,
    },
    // Test surface.
    executed,
    setRemoteMissing() {
      remoteMissing = true;
    },
  };
  return {
    ctx: ctx as unknown as ClientContext & {
      executed: typeof executed;
      setRemoteMissing(): void;
    },
    executed,
  };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("mount wiring — the seats ride the ONE command transport (ticket 101)", () => {
  it("add seat executes /dispatcher-start in the chosen session", async () => {
    const { ctx, executed } = createMountCtx();
    const mount = mountShellPage(ctx);

    mount.hosts.onAddDispatcherSession?.("s-target");
    await drain();

    assert.equal(executed.length, 1);
    assert.deepEqual(executed[0], {
      sessionId: "s-target",
      line: "/dispatcher-start",
      attachments: [],
    });
  });

  it("delete seat executes /dispatcher-stop in that session", async () => {
    const { ctx, executed } = createMountCtx();
    const mount = mountShellPage(ctx);

    mount.hosts.onDeleteDispatcherSession?.("s-target");
    await drain();

    assert.equal(executed.length, 1);
    assert.deepEqual(executed[0], {
      sessionId: "s-target",
      line: "/dispatcher-stop",
      attachments: [],
    });
  });

  it("an absent remote face is contained (no throw, honest no-channel)", async () => {
    const { ctx, executed } = createMountCtx();
    ctx.setRemoteMissing();
    const mount = mountShellPage(ctx);

    assert.doesNotThrow(() => mount.hosts.onDeleteDispatcherSession?.("s-1"));
    assert.doesNotThrow(() => mount.hosts.onAddDispatcherSession?.("s-1"));
    await drain();
    assert.deepEqual(executed, []);
  });

  it("a transport rejection is contained: the seat never throws, writes nothing itself", async () => {
    const rejecting = {
      effect(execute: () => unknown) {
        const returned = execute();
        void (typeof returned === "function" ? returned : () => {});
      },
      locale: {
        register() {
          return () => {};
        },
        bind() {
          return (key: string) => key;
        },
      },
      remote: {
        commands: {
          execute() {
            return Promise.reject(new Error("transport down"));
          },
        },
      },
      sessions: {
        list: { getSnapshot: () => ({ ids: [], byId: {} }) },
        scope: () => undefined,
      },
    } as unknown as ClientContext;
    const mount = mountShellPage(rejecting);
    await assert.doesNotReject(async () => {
      mount.hosts.onDeleteDispatcherSession?.("s-1");
      await drain();
    });
  });
});

describe("posture — session lifecycle only, never worker/turn management", () => {
  it("the mounted hosts carry no stop/cancel/kill-style key", () => {
    const { ctx } = createMountCtx();
    const mount = mountShellPage(ctx);
    const offenders = Object.keys(mount.hosts).filter((key) =>
      /stop|cancel|kill|abort|deactivate|terminate|destroy/i.test(key),
    );
    assert.deepEqual(
      offenders,
      [],
      `the shell hosts must not carry worker-kill-style affordance keys; found: ${offenders.join(", ")}`,
    );
    // The lifecycle seats ARE present, under the sanctioned vocabulary.
    assert.equal(typeof mount.hosts.onAddDispatcherSession, "function");
    assert.equal(typeof mount.hosts.onDeleteDispatcherSession, "function");
  });

  it("the one egress transport carries exactly the two user send paths", () => {
    const transport = bindCommandTransport({
      remote: () => undefined,
      sessions: () => undefined,
    });
    assert.deepEqual(Object.keys(transport).sort(), [
      "sendCommand",
      "sendPrompt",
    ]);
    // The session-lifecycle lines are the two sanctioned host commands.
    assert.equal(DISPATCHER_START_LINE, "/dispatcher-start");
    assert.equal(DISPATCHER_STOP_LINE, "/dispatcher-stop");
  });
});
