/**
 * Ticket 68 — onboarding first-run flow (ADR-0018 in-scope area).
 *
 * Offline only (S8): the suppression matrix, the seen-record parsing (the
 * fail-open pin), the beat walk, the pane view model, and the composition
 * wiring over fakes — the established client-suite style. Component rendering
 * stays covered by build success + typecheck (the shell's own discipline);
 * the live first-run visual pass is the 45/33 lane and is deliberately NOT
 * claimed here.
 *
 * The settings-backed seen record left with dsh 0.2.1: only the plugin's
 * declared volatile fields are accepted, so an undeclared `onboarding` key
 * would be rejected. The store keeps a generic seen-value channel and the
 * record parser; nothing feeds it by default.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ONBOARDING_BEATS,
  createOnboardingStore,
  describeOnboardingPane,
  isOnboardingSeenRecord,
  isOnboardingSuppressed,
  type OnboardingBox,
} from "../src/client/onboarding.js";
import {
  ONBOARDING_CLASS,
  ONBOARDING_CSS,
  createOnboardingPane,
} from "../src/client/onboarding-pane.js";
import {
  localeDictionary,
  validateLocaleDictionary,
} from "../src/client/overlay.js";
import {
  apply,
  applyClientModule,
  mountShellPage,
} from "../src/client/index.js";
import { createDispatcherShell } from "../src/client/shell.js";
import {
  createDispatcherShellStore,
  type ShellMirror,
} from "../src/client/shell-store.js";
import { createRosterStore } from "../src/client/roster-store.js";
import { createSettingsCardStore } from "../src/client/settings-card-store.js";
import type { ClientContext } from "../src/client/context.js";
import type { RosterSnapshot } from "../src/core/roster-snapshot.js";

/** One recorded slot entry in a fake's per-slot cell (ticket 86). */
interface FakeSlotEntry {
  options: Record<string, unknown>;
  component: unknown;
  dispose(): void;
}

/**
 * The shipped SlotCore register rule, shared by this file's fake (ticket 86):
 * cell lookup by slot name, `(priority ?? 0)` default, per-kind collision
 * throw with host wording, ascending insert sort, entry disposer.
 * (dsh-web-frontend `dist/assets/index-BKQ_L1z6.js`, minified SlotCore.register.)
 */
function registerSlotEntry(
  cells: Map<string, FakeSlotEntry[]>,
  owners: FakeSlotEntry[],
  rawOptions: unknown,
  component: unknown,
): () => void {
  const options = rawOptions as {
    name: string;
    key?: string;
    id?: string;
    priority?: number;
  };
  assert.equal(
    typeof options.name,
    "string",
    "slot options need a string `name` (fake)",
  );
  const cell = cells.get(options.name) ?? [];
  cells.set(options.name, cell);
  const priority = options.priority ?? 0;
  const collision = cell.find((entry) => {
    const other = entry.options as {
      key?: string;
      id?: string;
      priority?: number;
    };
    if (options.key !== undefined) {
      return other.key === options.key && (other.priority ?? 0) === priority;
    }
    if (options.id !== undefined) {
      return other.id === options.id && (other.priority ?? 0) === priority;
    }
    return (other.priority ?? 0) === priority;
  });
  if (collision !== undefined) {
    const target =
      options.key !== undefined
        ? `already has an entry for key "${options.key}"`
        : options.id !== undefined
          ? `already has an entry with id "${options.id}"`
          : "already has a registration";
    const kind =
      options.key !== undefined
        ? "keyed slot"
        : options.id !== undefined
          ? "list slot"
          : "single slot";
    throw new Error(
      `${kind} "${options.name}" ${target} at priority ${priority} — ` +
        `register at a different priority to shadow it (lowest renders)`,
    );
  }
  const entry: FakeSlotEntry = {
    options: { ...rawOptions } as Record<string, unknown>,
    component,
    dispose: () => {},
  };
  cell.push(entry);
  cell.sort(
    (a, b) =>
      ((a.options.priority as number | undefined) ?? 0) -
      ((b.options.priority as number | undefined) ?? 0),
  );
  entry.dispose = () => {
    const ownerAt = owners.indexOf(entry);
    if (ownerAt >= 0) owners.splice(ownerAt, 1);
    const cellAt = cell.indexOf(entry);
    if (cellAt >= 0) cell.splice(cellAt, 1);
  };
  owners.push(entry);
  return entry.dispose;
}

/** A mirror factory: the suppression decision's "dispatcher session" input. */
function mirror(kind: ShellMirror["kind"]): ShellMirror {
  if (kind === "snapshot") {
    const snapshot: RosterSnapshot = {
      schemaVersion: 4,
      dispatcherSessionId: "s-x",
      publishedAtMs: 1_000,
      workers: [],
      recentResult: null,
      pendingAsks: [],
    };
    return { kind: "snapshot", snapshot };
  }
  return { kind } as ShellMirror;
}

const NO_MIRRORS: ReadonlyMap<string, ShellMirror> = new Map();

function box(
  overrides: Partial<OnboardingBox> = {},
): Pick<
  OnboardingBox,
  "seenValue" | "buffering" | "beatIndex" | "phase" | "saveFailed"
> {
  return {
    seenValue: undefined,
    buffering: false,
    beatIndex: 0,
    phase: "beats",
    saveFailed: false,
    ...overrides,
  };
}

describe("onboarding beats (ticket 68, AC 1)", () => {
  it("maps the reference's honest-counterpart sequence onto five beats, in order", () => {
    // `always-on-dispatcher-behavior.md:18`: intro → background-jobs → tools
    // → first agent → hand-off. The sign-in beat and the computer-readiness
    // demo have NO beat here — a U-A gap and a 71-dependent capability gap
    // are recorded, never staged as panes.
    assert.deepEqual(
      ONBOARDING_BEATS.map((beat) => beat.id),
      ["intro", "background", "tools", "first", "handoff"],
    );
    for (const beat of ONBOARDING_BEATS) {
      assert.match(beat.titleKey, new RegExp(`^shell\\.onboard\\.${beat.id}\\.title$`));
      assert.match(beat.bodyKey, new RegExp(`^shell\\.onboard\\.${beat.id}\\.body$`));
    }
  });

  it("every beat's copy exists in BOTH faces, and the dictionary stays valid", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    for (const beat of ONBOARDING_BEATS) {
      for (const key of [beat.titleKey, beat.bodyKey]) {
        assert.equal(typeof localeDictionary.en[key], "string", `en missing ${key}`);
        assert.equal(typeof localeDictionary.zh[key], "string", `zh missing ${key}`);
      }
    }
  });

  it("no beat copy invents a U-A counterpart (no account/sign-in/connection phases)", () => {
    for (const beat of ONBOARDING_BEATS) {
      for (const key of [beat.titleKey, beat.bodyKey]) {
        const copy = (localeDictionary.en[key] ?? "").toLowerCase();
        assert.doesNotMatch(copy, /sign|account|privacy|connect/, `${key} invents a U-A beat`);
      }
    }
  });

  it("the flow's own copy stays retry-less and push-less (U-A; one honest failure line)", () => {
    const keys = Object.keys(localeDictionary.en).filter((key) =>
      key.startsWith("shell.onboard."),
    );
    assert.ok(keys.length >= 12, "onboarding copy keys missing");
    for (const key of keys) {
      const copy = (localeDictionary.en[key] ?? "").toLowerCase();
      assert.doesNotMatch(copy, /retry|reconnect|refresh/, `${key} suggests a retry`);
      assert.doesNotMatch(copy, /notif|toast|alert|push/, `${key} simulates a push channel`);
    }
  });
});

describe("onboarding seen record — parse + fail-open (ticket 68, AC 2)", () => {
  it("a well-formed {seen:true} record suppresses; extra bookkeeping fields tolerated", () => {
    assert.equal(isOnboardingSeenRecord({ seen: true }), true);
    assert.equal(isOnboardingSeenRecord({ seen: true, atMs: 1_234 }), true);
  });

  it("every corrupt or unreadable shape reads as NOT seen — the fail-open pin", () => {
    for (const junk of [
      undefined,
      null,
      "yes",
      42,
      true,
      [],
      ["seen"],
      {},
      { seen: "true" },
      { seen: 1 },
      { seen: false },
    ]) {
      assert.equal(
        isOnboardingSeenRecord(junk),
        false,
        `corrupt record ${JSON.stringify(junk)} must fail OPEN`,
      );
    }
  });
});

describe("onboarding suppression decision (ticket 68, AC 2)", () => {
  it("not seen + no dispatcher mirrors: the flow SHOWS", () => {
    assert.equal(isOnboardingSuppressed(undefined, NO_MIRRORS), false);
  });

  it("a well-formed seen record suppresses even with no dispatcher sessions", () => {
    assert.equal(isOnboardingSuppressed({ seen: true }, NO_MIRRORS), true);
  });

  it("a corrupt seen record fails OPEN — the flow shows, never silently hides", () => {
    for (const junk of [undefined, "corrupt", { seen: "yes" }, 0]) {
      assert.equal(isOnboardingSuppressed(junk, NO_MIRRORS), false, String(junk));
    }
  });

  it("≥1 dispatcher mirror suppresses (the ticket-76 keying: roster.<id> existence)", () => {
    const mirrors = new Map([["s-1", mirror("snapshot")]]);
    assert.equal(isOnboardingSuppressed(undefined, mirrors), true);
  });

  it("a corrupt mirror payload still proves the session is ours — suppressed", () => {
    const mirrors = new Map([["s-1", mirror("unavailable")]]);
    assert.equal(isOnboardingSuppressed(undefined, mirrors), true);
  });

  it("cleared-only mirrors (host wrote null on deactivation) do NOT suppress", () => {
    const mirrors = new Map([["s-1", mirror("cleared")]]);
    assert.equal(isOnboardingSuppressed(undefined, mirrors), false);
    // …but a cleared mirror never beats a seen record either.
    assert.equal(isOnboardingSuppressed({ seen: true }, mirrors), true);
  });

  it("mixed mirrors: any non-cleared session suppresses", () => {
    const mirrors = new Map([
      ["s-1", mirror("cleared")],
      ["s-2", mirror("snapshot")],
    ]);
    assert.equal(isOnboardingSuppressed(undefined, mirrors), true);
  });
});

describe("onboarding store — seen-flag lifecycle + beat walk (ticket 68)", () => {
  it("starts at beat one, beats phase, no seen input, no failure, not buffering", () => {
    const store = createOnboardingStore();
    assert.deepEqual(store.getBox(), {
      seenValue: undefined,
      buffering: false,
      beatIndex: 0,
      phase: "beats",
      saveFailed: false,
      version: 0,
    });
  });

  it("applySeenValue feeds the seen input (round trip)", () => {
    const store = createOnboardingStore();
    const versions: number[] = [];
    store.subscribe(() => versions.push(store.getBox().version));
    store.applySeenValue({ seen: true });
    assert.deepEqual(store.getBox().seenValue, { seen: true });
    store.applySeenValue("corrupt");
    assert.equal(store.getBox().seenValue, "corrupt"); // fail-open input
    store.applySeenValue(undefined);
    assert.equal(store.getBox().seenValue, undefined);
    assert.equal(versions.length, 3);
  });

  it("a re-delivered identical value does not emit (stable snapshots, no churn)", () => {
    const store = createOnboardingStore();
    const seen = { seen: true };
    store.applySeenValue(seen);
    const version = store.getBox().version;
    store.applySeenValue(seen);
    assert.equal(store.getBox().version, version);
  });

  it("advance walks the beats and clamps at the last; it never passes the end", () => {
    const store = createOnboardingStore();
    for (let expected = 1; expected <= ONBOARDING_BEATS.length - 1; expected += 1) {
      store.advance();
      assert.equal(store.getBox().beatIndex, expected);
    }
    const version = store.getBox().version;
    store.advance();
    store.advance();
    assert.equal(store.getBox().version, version, "advancing at the last beat is a no-op");
    assert.equal(store.getBox().beatIndex, ONBOARDING_BEATS.length - 1);
  });

  it("complete settles the flow; advance after done does nothing; re-complete does not emit", () => {
    const store = createOnboardingStore();
    let emissions = 0;
    store.subscribe(() => {
      emissions += 1;
    });
    store.complete();
    assert.equal(store.getBox().phase, "done");
    const version = store.getBox().version;
    store.complete();
    store.advance();
    assert.equal(store.getBox().version, version);
    assert.equal(emissions, 1);
  });

  it("markSaveFailed records the honest failed write exactly once", () => {
    const store = createOnboardingStore();
    store.markSaveFailed();
    const version = store.getBox().version;
    store.markSaveFailed();
    assert.equal(store.getBox().version, version);
    assert.equal(store.getBox().saveFailed, true);
  });
});

describe("onboarding pane view model — render states (ticket 68)", () => {
  it("first run renders the intro beat with step 1/N and a non-last primary", () => {
    const view = describeOnboardingPane(box(), NO_MIRRORS);
    assert.equal(view.kind, "beats");
    if (view.kind !== "beats") return;
    assert.equal(view.beatId, "intro");
    assert.equal(view.titleKey, "shell.onboard.intro.title");
    assert.equal(view.stepCurrent, 1);
    assert.equal(view.stepTotal, ONBOARDING_BEATS.length);
    assert.equal(view.activeDot, 0);
    assert.equal(view.isLast, false);
  });

  it("mid-walk and last-beat states follow the store", () => {
    const last = ONBOARDING_BEATS.length - 1;
    const view = describeOnboardingPane(box({ beatIndex: last }), NO_MIRRORS);
    assert.equal(view.kind, "beats");
    if (view.kind !== "beats") return;
    assert.equal(view.beatId, "handoff");
    assert.equal(view.isLast, true);
    assert.equal(view.stepCurrent, ONBOARDING_BEATS.length);
  });

  it("a completed flow settles; the failed write carries the honest line", () => {
    assert.deepEqual(describeOnboardingPane(box({ phase: "done" }), NO_MIRRORS), {
      kind: "settled",
      saveFailed: false,
    });
    assert.deepEqual(
      describeOnboardingPane(box({ phase: "done", saveFailed: true }), NO_MIRRORS),
      { kind: "settled", saveFailed: true },
    );
  });

  it("suppression settles the pane regardless of phase (seen record and mirrors)", () => {
    assert.deepEqual(describeOnboardingPane(box({ seenValue: { seen: true } }), NO_MIRRORS), {
      kind: "settled",
      saveFailed: false,
    });
    const mirrors = new Map([["s-1", mirror("snapshot")]]);
    assert.deepEqual(describeOnboardingPane(box(), mirrors), {
      kind: "settled",
      saveFailed: false,
    });
    // A suppressed pane never shows the save-failed line — nothing failed.
    assert.deepEqual(
      describeOnboardingPane(box({ seenValue: { seen: true }, saveFailed: true }), NO_MIRRORS),
      { kind: "settled", saveFailed: false },
    );
  });

  it("the pane factory binds to store + shell store + the seen hand-off (wiring smoke)", () => {
    const pane = createOnboardingPane(
      (key) => localeDictionary.en[key] ?? key,
      createOnboardingStore(),
      createDispatcherShellStore(),
      { onSeen: () => {} },
    );
    assert.equal(typeof pane, "function"); // never invoked offline (hooks need a renderer)
  });
});

describe("onboarding settle gating — the racy seen read (ticket 87)", () => {
  it("a scope-reported in-flight read buffers the pane: pending, never the flow", () => {
    const store = createOnboardingStore();
    const versions: number[] = [];
    store.subscribe(() => versions.push(store.getBox().version));
    store.applySnapshot("loading", undefined);
    assert.equal(store.getBox().buffering, true);
    assert.equal(
      describeOnboardingPane(store.getBox(), NO_MIRRORS).kind,
      "pending",
      "the flow must not render from the fail-open default mid-read",
    );
    // Re-delivered in-flight reports do not churn (stable snapshots).
    const version = store.getBox().version;
    store.applySnapshot("loading", undefined);
    store.applySnapshot("ready", undefined); // value-less ready = still pre-acceptance
    assert.equal(store.getBox().version, version, "no emit churn while in flight");
    assert.equal(versions.length, 1);
  });

  it("THE LOSING ORDER (live reload #1): the value arrives AFTER the first decision — pending → settled, never beats", () => {
    const store = createOnboardingStore();
    // The read starts with no value delivered yet. Deciding here reads the
    // fail-open default and re-shows the flow on a reload whose record stands
    // — the pass-4 symptom.
    store.applySnapshot("loading", undefined);
    assert.equal(describeOnboardingPane(store.getBox(), NO_MIRRORS).kind, "pending");
    // The value lands (the persisted seen record served back):
    store.applySnapshot("ready", { seen: true });
    assert.equal(store.getBox().buffering, false);
    assert.deepEqual(store.getBox().seenValue, { seen: true });
    assert.equal(describeOnboardingPane(store.getBox(), NO_MIRRORS).kind, "settled");
  });

  it("a fresh profile (the read lands WITHOUT a seen record) shows the flow — only after the read settles", () => {
    const store = createOnboardingStore();
    store.applySnapshot("loading", undefined);
    assert.equal(describeOnboardingPane(store.getBox(), NO_MIRRORS).kind, "pending");
    store.applySnapshot("ready", undefined);
    // A value-less `ready` stays pre-acceptance: nothing was delivered.
    assert.equal(store.getBox().buffering, true);
    store.applySnapshot("ready", "not-seen");
    assert.equal(store.getBox().buffering, false);
    assert.equal(
      describeOnboardingPane(store.getBox(), NO_MIRRORS).kind,
      "beats",
      "fail-open still shows a genuinely-first-run flow, after the settle",
    );
  });

  it("unavailable SETTLES the read: buffering ends and the flow shows (fail-open)", () => {
    const store = createOnboardingStore();
    store.applySnapshot("loading", undefined);
    store.applySnapshot("unavailable", undefined);
    assert.equal(store.getBox().buffering, false);
    assert.equal(store.getBox().seenValue, undefined);
    assert.equal(
      describeOnboardingPane(store.getBox(), NO_MIRRORS).kind,
      "beats",
      "an unreadable record must SHOW the flow — buffering may not strand it",
    );
  });

  it("INVERSE HAZARD: a stale seen=true value is corrected by a later value without it — the flow re-opens", () => {
    const store = createOnboardingStore();
    store.applySnapshot("ready", { seen: true });
    assert.equal(describeOnboardingPane(store.getBox(), NO_MIRRORS).kind, "settled");
    store.applySeenValue(undefined);
    assert.equal(store.getBox().seenValue, undefined);
    assert.equal(
      describeOnboardingPane(store.getBox(), NO_MIRRORS).kind,
      "beats",
      "a transient stale record must not suppress wrongly",
    );
    // A non-record value also fails open.
    store.applySnapshot("ready", "fresh");
    assert.equal(
      describeOnboardingPane(store.getBox(), NO_MIRRORS).kind,
      "beats",
    );
  });

  it("no channel ever reports in-flight → the flow shows (the fail-open pin, unbuffered)", () => {
    const store = createOnboardingStore();
    assert.equal(store.getBox().buffering, false);
    assert.equal(describeOnboardingPane(store.getBox(), NO_MIRRORS).kind, "beats");
  });

  it("the decision is REACTIVE through the store emit — an arrival re-evaluates without a second decision point", () => {
    const store = createOnboardingStore();
    const kinds: string[] = [];
    store.subscribe(() => {
      kinds.push(describeOnboardingPane(store.getBox(), NO_MIRRORS).kind);
    });
    store.applySnapshot("loading", undefined);
    store.applySnapshot("ready", { seen: true });
    assert.deepEqual(kinds, ["pending", "settled"]);
  });

  it("a dispatcher mirror suppresses even while the read is in flight (durable proof needs no document)", () => {
    const store = createOnboardingStore();
    store.applySnapshot("loading", undefined);
    const mirrors = new Map([["s-1", mirror("snapshot")]]);
    assert.equal(describeOnboardingPane(store.getBox(), mirrors).kind, "settled");
  });
});

describe("onboarding CSS contract (ticket 68, ticket 49's discipline)", () => {
  const tokens = [
    ...new Set(
      [...ONBOARDING_CSS.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g)].map((m) => m[1]!),
    ),
  ].sort();

  it("carries no raw colour literal — every colour is a host token", () => {
    assert.doesNotMatch(ONBOARDING_CSS, /#[0-9a-fA-F]{3,8}\b/, "hex literal");
    assert.doesNotMatch(ONBOARDING_CSS, /(?<![a-z])rgba?\(/, "rgb()/rgba() literal");
    assert.doesNotMatch(ONBOARDING_CSS, /hsla?\(/, "hsl() literal");
    assert.ok(tokens.length > 0, "no tokens referenced at all");
  });

  it("uses only tokens already evidenced by our shipped surfaces", () => {
    const allowed = new Set([
      "--dsw-alias-bg-layer-1",
      "--dsw-alias-bg-layer-3",
      "--dsw-alias-border-l3",
      "--dsw-alias-label-tertiary",
      "--dsw-alias-state-business-primary",
      "--dsw-alias-state-warn-primary",
    ]);
    for (const token of tokens) {
      assert.ok(allowed.has(token), `token ${token} is not in the evidenced set`);
    }
  });

  it("namespaces every class and ships no animation at all", () => {
    const foreign = [...ONBOARDING_CSS.matchAll(/\.([a-z-][a-z0-9_-]*)/g)]
      .map((m) => m[1]!)
      .filter((name) => !name.startsWith("multitask-dispatcher-"));
    assert.deepEqual(foreign, []);
    assert.doesNotMatch(ONBOARDING_CSS, /@keyframes|animation:/);
  });

  it("opens with the pane class", () => {
    assert.match(ONBOARDING_CSS.trim(), new RegExp(`^\\.${ONBOARDING_CLASS}\\{`));
  });
});

describe("onboarding shell seat + composition wiring (ticket 68)", () => {
  /**
   * Fake ctx: the mount fake over the declared service faces.
   *
   * Ticket 86 (2026-09-19): the slots fake carries the shipped SlotCore
   * register rule (one cell per slot name, `(priority ?? 0)` default, per-kind
   * collision throw with host wording) so a colliding registration fails here
   * instead of live. See test/client-face-scaffold.test.ts for the full
   * citation (`dsh-web-frontend/dist/assets/index-BKQ_L1z6.js`, minified
   * SlotCore.register).
   */
  function createOnboardingCtx() {
    const locales = new Map<string, unknown>();
    const cells = new Map<string, FakeSlotEntry[]>();
    const injects: Array<{
      parent: string;
      entries: FakeSlotEntry[];
    }> = [];
    const effectDisposers: Array<() => void> = [];
    const injectControllers: Array<() => void> = [];
    const base = {
      effect(execute: () => unknown) {
        const returned = execute();
        if (typeof returned === "function") {
          effectDisposers.push(returned as () => void);
        }
      },
      slots: {
        inject(parent: string, callback: () => unknown) {
          const record = { parent, entries: [] as FakeSlotEntry[] };
          injects.push(record);
          callback();
          const controller = () => {
            const at = injects.indexOf(record);
            if (at >= 0) injects.splice(at, 1);
            for (const entry of record.entries.splice(0)) entry.dispose();
          };
          injectControllers.push(controller);
          return controller;
        },
        register(options: unknown, component: unknown) {
          const owner = injects.at(-1);
          assert.ok(owner, "slots.register outside of slots.inject (fake)");
          return registerSlotEntry(cells, owner.entries, options, component);
        },
      },
      locale: {
        register(namespace: string, dictionary: unknown) {
          locales.set(namespace, dictionary);
          return () => {
            locales.delete(namespace);
          };
        },
        bind(namespace: string) {
          return (key: string) => {
            const dict = locales.get(namespace) as
              | { en: Record<string, string> }
              | undefined;
            return dict?.en[key] ?? key;
          };
        },
      },
      injects,
      cells,
      runFiberTeardown() {
        for (const dispose of [
          ...effectDisposers.reverse(),
          ...injectControllers.reverse(),
        ]) {
          dispose();
        }
      },
    };
    return base as typeof base & ClientContext;
  }

  function applyWith(ctx: ClientContext, onboarding = createOnboardingStore()) {
    applyClientModule(
      ctx,
      createRosterStore(),
      createSettingsCardStore(),
      onboarding,
    );
    return onboarding;
  }

  it("mountShellPage hosts the seat only when the wiring is provided", () => {
    const bare = mountShellPage(createOnboardingCtx());
    assert.equal(bare.hosts.onboarding, undefined);

    const wired = mountShellPage(createOnboardingCtx(), {
      store: createOnboardingStore(),
      onSeen: () => {},
    });
    assert.equal(typeof wired.hosts.onboarding, "function"); // never invoked offline
  });

  it("the composition feeds NO seen input: the settings-backed record has no channel on 0.2.1", () => {
    const onboarding = applyWith(createOnboardingCtx());
    assert.equal(onboarding.getBox().seenValue, undefined);
    assert.equal(onboarding.getBox().buffering, false);
    assert.equal(
      describeOnboardingPane(onboarding.getBox(), new Map()).kind,
      "beats",
      "with no record channel the fail-open default shows the flow",
    );
  });

  it("the seen write has no channel: marking the failure is the honest outcome", () => {
    const onboarding = applyWith(createOnboardingCtx());
    // A surface that returns must feed a real transport; until then the flow
    // simply shows again next launch (fail-open).
    onboarding.complete();
    assert.equal(onboarding.getBox().phase, "done");
    onboarding.markSaveFailed();
    assert.equal(onboarding.getBox().saveFailed, true);
  });

  it("the shell component factory accepts the onboarding seat (wiring smoke)", () => {
    const component = createDispatcherShell(
      (key) => localeDictionary.en[key] ?? key,
      createDispatcherShellStore(),
      { onboarding: () => null },
    );
    assert.equal(typeof component, "function");
  });

  it("a full apply() registers only the additive entries and nothing in dsh's layout", () => {
    const ctx = createOnboardingCtx();
    assert.doesNotThrow(() => apply(ctx));
    // The default composition's four declaration waits: toolviews, the
    // settings page, the sidebar session-kind glyph (ticket 123), and the
    // header chip (ticket 140).
    assert.equal(ctx.injects.length, 4);
    const main = ctx.injects.find((record) => record.parent === "main");
    assert.equal(main, undefined, "no `main` page in the default posture");
  });
});
