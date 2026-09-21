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
 *
 * Ticket 106 (2026-09-22) extends the suite: the right-click close menu's
 * seat (`onCloseDispatcherSession` — "close" deliberately clear of the
 * banned-verb scan) rides the SAME `/dispatcher-stop` egress, the menu
 * reuses the delete affordance's armed-window reducer with its own slot,
 * and the menu's fixed-position clamp is pinned pure.
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
import { mountShellPage, inject as clientInject } from "../src/client/index.js";
import {
  clampRowMenuPosition,
  SHELL_ROW_MENU_BOX,
} from "../src/client/shell.js";
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

/**
 * Ticket 106 — the right-click close menu REUSES the delete affordance's
 * armed-window reducer (`shellDeletePress`); the pure rule is already pinned
 * above (arm → confirm, timeout expiry, second arm replaces, displaced-arm
 * isolation). What is new here is the SLOT discipline: the menu holds its
 * own arm state, independent of a row button's, so arming one surface can
 * never confirm the other — same reducer, separate state.
 */
describe("close menu — the reused reducer with its own arm slot (ticket 106)", () => {
  it("the menu item arms then confirms inside the window via shellDeletePress", () => {
    let menuArm = SHELL_DELETE_IDLE;
    const first = shellDeletePress(menuArm, "s-menu", 2_000);
    assert.equal(first.action, "arm");
    menuArm = first.state;
    const second = shellDeletePress(
      menuArm,
      "s-menu",
      2_000 + SHELL_DELETE_CONFIRM_MS - 1,
    );
    assert.equal(second.action, "confirm", "inside the window: confirmed");
    assert.deepEqual(second.state, SHELL_DELETE_IDLE, "confirmed: disarm");
  });

  it("the menu slot is independent of a row's delete slot — one cannot confirm the other", () => {
    const deleteArm = shellDeletePress(SHELL_DELETE_IDLE, "s-1", 1_000).state;
    const menuArm = shellDeletePress(SHELL_DELETE_IDLE, "s-1", 2_000).state;
    // Displacing the DELETE slot's arm (arming another row there) cannot
    // disarm the MENU slot's: separate state, one shared rule.
    const displacedDelete = shellDeletePress(deleteArm, "s-2", 1_100).state;
    const menuConfirm = shellDeletePress(menuArm, "s-1", 2_100);
    assert.equal(displacedDelete.armedSessionId, "s-2");
    assert.equal(menuConfirm.action, "confirm");
  });
});

describe("row menu position clamp (ticket 106)", () => {
  it("a cursor point away from the edges passes through; edge points pull the menu on-screen", () => {
    assert.deepEqual(clampRowMenuPosition(40, 30, 1600, 900), {
      left: 40,
      top: 30,
    });
    assert.deepEqual(
      clampRowMenuPosition(1590, 880, 1600, 900),
      {
        left: 1600 - SHELL_ROW_MENU_BOX.width,
        top: 900 - SHELL_ROW_MENU_BOX.height,
      },
      "near the bottom-right edge the menu stays inside the viewport",
    );
    assert.deepEqual(
      clampRowMenuPosition(-20, -5, 1600, 900),
      { left: 0, top: 0 },
      "negative cursor points pin at the corner, never NaN",
    );
  });
});

// ── The real mount wiring over a minimal client fake ───────────────────────

// Ticket 102b: the nested `remote.commands` face is its own inject entry —
// the resolver matches by exact string and never dot-splits, so this guard
// keys on the module's REAL exported declaration. If `src/client/index.ts`
// ever drops the nested name again, `.commands` reads here throw exactly as
// the live context proxy does and the seat tests below go red.
const NESTED_FACE_DECLARED = clientInject.includes("remote.commands");

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
      // The real service instance is reachable through the declared parent
      // face; reading the NESTED member re-enters the resolver at the full
      // dotted name and throws when that name is not declared (the live
      // `cannot get property "remote.commands" without inject`).
      const commands = {
        execute(
          sessionId: string,
          line: string,
          attachments: readonly unknown[],
        ) {
          executed.push({ sessionId, line, attachments });
          return Promise.resolve({ kind: "success", text: "ok" });
        },
      };
      return {
        get commands() {
          if (!NESTED_FACE_DECLARED) {
            throw new Error(
              'cannot get property "remote.commands" without inject',
            );
          }
          return commands;
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

  it("close seat (the right-click menu, ticket 106) executes /dispatcher-stop in that session through the same transport", async () => {
    const { ctx, executed } = createMountCtx();
    const mount = mountShellPage(ctx);

    mount.hosts.onCloseDispatcherSession?.("s-target");
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
    assert.doesNotThrow(() => mount.hosts.onCloseDispatcherSession?.("s-1"));
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
      mount.hosts.onCloseDispatcherSession?.("s-1");
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
    // The lifecycle seats ARE present, under the sanctioned vocabulary —
    // add, delete, and ticket 106's close (the right-click menu's seat;
    // "close" names the session-lifecycle verb without tripping the scan).
    assert.equal(typeof mount.hosts.onAddDispatcherSession, "function");
    assert.equal(typeof mount.hosts.onDeleteDispatcherSession, "function");
    assert.equal(typeof mount.hosts.onCloseDispatcherSession, "function");
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

  it("a THROWING nested-face read resolves to no-channel, never a rejection (ticket 102b)", async () => {
    // The live defect's exact shape: the resolver throws at the property
    // READ (not a call) when the nested dotted name is not in the inject
    // list, and `typeof remote.commands?.execute` cannot catch a throwing
    // getter. The transport must absorb it as the honest `no-channel`
    // result — the same outcome a structurally absent face gives — instead
    // of a rejected promise the seats swallow.
    const transport = bindCommandTransport({
      remote: () => ({
        get commands(): never {
          throw new Error(
            'cannot get property "remote.commands" without inject',
          );
        },
      }),
      sessions: () => undefined,
    });
    assert.deepEqual(await transport.sendCommand("s-1", "/dispatcher-start"), {
      kind: "no-channel",
    });
  });
});
