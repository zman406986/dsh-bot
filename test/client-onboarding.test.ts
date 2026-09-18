/**
 * Ticket 68 — onboarding first-run flow (ADR-0018 in-scope area).
 *
 * Offline only (S8): the suppression matrix, the seen-record parsing (the
 * fail-open pin), the beat walk, the pane view model, the seen-write
 * hand-off, and the composition wiring over fakes — the established
 * client-suite style. Component rendering stays covered by build success +
 * typecheck (the shell's own discipline); the live first-run visual pass is
 * the 45/33 lane and is deliberately NOT claimed here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ONBOARDING_BEATS,
  ONBOARDING_SETTINGS_KEY,
  createOnboardingStore,
  describeOnboardingPane,
  isOnboardingSeenRecord,
  isOnboardingSuppressed,
  onboardingSeenFromDocument,
  writeOnboardingSeenRecord,
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
import {
  createCapsuleFooterStore,
  createCapsuleStore,
} from "../src/client/capsule-store.js";
import { createSettingsCardStore } from "../src/client/settings-card-store.js";
import type {
  ClientContext,
  ClientSettingsScopeLike,
  ClientSettingsScopeSnapshotLike,
} from "../src/client/context.js";
import type { RosterSnapshot } from "../src/core/roster-snapshot.js";

/** A mirror factory: the suppression decision's "dispatcher session" input. */
function mirror(kind: ShellMirror["kind"]): ShellMirror {
  if (kind === "snapshot") {
    const snapshot: RosterSnapshot = {
      schemaVersion: 3,
      dispatcherSessionId: "s-x",
      publishedAtMs: 1_000,
      workers: [],
      recentResult: null,
    };
    return { kind: "snapshot", snapshot };
  }
  return { kind } as ShellMirror;
}

const NO_MIRRORS: ReadonlyMap<string, ShellMirror> = new Map();

function box(
  overrides: Partial<OnboardingBox> = {},
): Pick<OnboardingBox, "seenValue" | "beatIndex" | "phase" | "saveFailed"> {
  return {
    seenValue: undefined,
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

  it("extracts the record from the namespace document; unreadable documents yield undefined", () => {
    assert.deepEqual(onboardingSeenFromDocument({ [ONBOARDING_SETTINGS_KEY]: { seen: true } }), {
      seen: true,
    });
    assert.equal(onboardingSeenFromDocument({ enabled: true }), undefined);
    assert.equal(onboardingSeenFromDocument(undefined), undefined);
    assert.equal(onboardingSeenFromDocument("garbage"), undefined);
    assert.equal(onboardingSeenFromDocument([1, 2]), undefined);
  });

  it("the key rides OUR settings namespace (A5) and stays stable", () => {
    assert.equal(ONBOARDING_SETTINGS_KEY, "onboarding");
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
  it("starts at beat one, beats phase, no seen input, no failure", () => {
    const store = createOnboardingStore();
    assert.deepEqual(store.getBox(), {
      seenValue: undefined,
      beatIndex: 0,
      phase: "beats",
      saveFailed: false,
      version: 0,
    });
  });

  it("applyDocument feeds the seen input from the namespace document (round trip)", () => {
    const store = createOnboardingStore();
    const versions: number[] = [];
    store.subscribe(() => versions.push(store.getBox().version));
    store.applyDocument({ enabled: true, [ONBOARDING_SETTINGS_KEY]: { seen: true } });
    assert.deepEqual(store.getBox().seenValue, { seen: true });
    store.applyDocument({ [ONBOARDING_SETTINGS_KEY]: "corrupt" });
    assert.equal(store.getBox().seenValue, "corrupt"); // fail-open input
    store.applyDocument(undefined);
    assert.equal(store.getBox().seenValue, undefined);
    assert.equal(versions.length, 3);
  });

  it("a re-delivered identical document does not emit (stable snapshots, no churn)", () => {
    const store = createOnboardingStore();
    const doc = { [ONBOARDING_SETTINGS_KEY]: { seen: true } };
    store.applyDocument(doc);
    const version = store.getBox().version;
    store.applyDocument(doc);
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

describe("onboarding seen-write hand-off (ticket 68)", () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("writes the seen record under the namespace key through the ONE bound scope", async () => {
    const setCalls: Array<{ field: string; value: unknown }> = [];
    let failed = false;
    writeOnboardingSeenRecord(
      {
        set: (field, value) => {
          setCalls.push({ field, value });
          return Promise.resolve();
        },
      },
      () => {
        failed = true;
      },
    );
    await settle();
    assert.deepEqual(setCalls, [{ field: ONBOARDING_SETTINGS_KEY, value: { seen: true } }]);
    assert.equal(failed, false, "a resolved write stays silent — no fake success surface");
  });

  it("no scope, or a scope without a write path, reports the honest failure (fail-open)", async () => {
    let failures = 0;
    writeOnboardingSeenRecord(null, () => {
      failures += 1;
    });
    writeOnboardingSeenRecord(undefined, () => {
      failures += 1;
    });
    writeOnboardingSeenRecord({}, () => {
      failures += 1;
    });
    await settle();
    assert.equal(failures, 3);
  });

  it("a rejected write reports the failure instead of a fake save", async () => {
    let failed = false;
    writeOnboardingSeenRecord(
      {
        set: () => Promise.reject(new Error("host refused the field")),
      },
      () => {
        failed = true;
      },
    );
    await settle();
    assert.equal(failed, true);
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
  /** Scope fake mirroring the shipped bind face (getSnapshot/subscribe/set). */
  function createScopeFake(
    initial: ClientSettingsScopeSnapshotLike,
    options: { rejectSet?: boolean } = {},
  ) {
    let snapshot = initial;
    const listeners = new Set<() => void>();
    const setCalls: Array<{ field: string; value: unknown }> = [];
    const scope: ClientSettingsScopeLike & { setCalls: typeof setCalls } = {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      set(field, value) {
        setCalls.push({ field, value });
        if (options.rejectSet === true) return Promise.reject(new Error("refused"));
        snapshot = {
          ...snapshot,
          value: {
            ...((snapshot.value ?? {}) as Record<string, unknown>),
            [field]: value,
          },
        };
        for (const listener of [...listeners]) listener();
        return Promise.resolve();
      },
      setCalls,
    };
    return {
      scope,
      setCalls,
      emit(next: ClientSettingsScopeSnapshotLike) {
        snapshot = next;
        for (const listener of [...listeners]) listener();
      },
    };
  }

  /** Fake ctx: the mount fake plus the settingsScope inject (scaffold idiom). */
  function createOnboardingCtx(scope: ClientSettingsScopeLike | undefined) {
    const locales = new Map<string, unknown>();
    const injects: Array<{
      parent: string;
      entries: Array<{ options: unknown; component: unknown }>;
    }> = [];
    const base = {
      effect(execute: () => unknown) {
        execute();
      },
      slots: {
        inject(parent: string, callback: () => unknown) {
          const record = { parent, entries: [] };
          injects.push(record);
          callback();
          return () => {
            const at = injects.indexOf(record);
            if (at >= 0) injects.splice(at, 1);
            record.entries.length = 0;
          };
        },
        register(options: unknown, component: unknown) {
          const owner = injects.at(-1);
          assert.ok(owner, "slots.register outside of slots.inject (fake)");
          owner.entries.push({ options, component });
          return () => {};
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
      injectRequests: [] as string[][],
      injects,
    };
    const ctx = base as typeof base & ClientContext;
    ctx.inject = (services: readonly string[], callback) => {
      (ctx.injectRequests as string[][]).push([...services]);
      if (scope === undefined || !services.includes("settingsScope")) return;
      callback({ settingsScope: { bind: () => scope } });
    };
    return ctx;
  }

  function applyWith(ctx: ClientContext, onboarding = createOnboardingStore()) {
    applyClientModule(
      ctx,
      createRosterStore(),
      createCapsuleStore(),
      createCapsuleFooterStore(),
      createSettingsCardStore(),
      onboarding,
    );
    return onboarding;
  }

  it("mountShellPage hosts the seat only when the wiring is provided", () => {
    const bare = mountShellPage(createOnboardingCtx(undefined));
    assert.equal(bare.hosts.onboarding, undefined);

    const wired = mountShellPage(createOnboardingCtx(undefined), {
      store: createOnboardingStore(),
      onSeen: () => {},
    });
    assert.equal(typeof wired.hosts.onboarding, "function"); // never invoked offline
  });

  it("applyClientModule feeds the onboarding store from the SAME settings bind (A5)", () => {
    const seen = { seen: true };
    const fake = createScopeFake({
      status: "ready",
      value: { enabled: true, [ONBOARDING_SETTINGS_KEY]: seen },
    });
    const ctx = createOnboardingCtx(fake.scope);
    const onboarding = applyWith(ctx);
    assert.deepEqual(ctx.injectRequests, [["settingsScope"]]);
    assert.deepEqual(onboarding.getBox().seenValue, seen);

    // A live replacement re-feeds the input; the suppression decision flips.
    fake.emit({ status: "ready", value: { enabled: true } });
    assert.equal(onboarding.getBox().seenValue, undefined);
  });

  it("an unavailable namespace resets the seen input — fail-open, never stranded", () => {
    const fake = createScopeFake({
      status: "ready",
      value: { [ONBOARDING_SETTINGS_KEY]: { seen: true } },
    });
    const onboarding = applyWith(createOnboardingCtx(fake.scope));
    assert.deepEqual(onboarding.getBox().seenValue, { seen: true });
    fake.emit({ status: "unavailable" });
    assert.equal(onboarding.getBox().seenValue, undefined);
    assert.equal(
      describeOnboardingPane(onboarding.getBox(), new Map()).kind,
      "beats",
      "an unreadable record must SHOW the flow",
    );
  });

  it("a runtime without the settingsScope degrades — the flow shows, nothing crashes", () => {
    const onboarding = applyWith(createOnboardingCtx(undefined));
    assert.equal(onboarding.getBox().seenValue, undefined);
    assert.equal(describeOnboardingPane(onboarding.getBox(), new Map()).kind, "beats");
  });

  it("the seen write rides the wired scope; a rejection marks the honest failure", async () => {
    const rejecting = createScopeFake({ status: "ready", value: {} }, { rejectSet: true });
    const onboarding = applyWith(createOnboardingCtx(rejecting.scope));
    // The same hand-off the composition captured for the pane's Done/Skip.
    writeOnboardingSeenRecord(rejecting.scope, () => onboarding.markSaveFailed());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(onboarding.getBox().saveFailed, true);
    assert.deepEqual(rejecting.setCalls, [
      { field: ONBOARDING_SETTINGS_KEY, value: { seen: true } },
    ]);
  });

  it("the shell component factory accepts the onboarding seat (wiring smoke)", () => {
    const component = createDispatcherShell(
      (key) => localeDictionary.en[key] ?? key,
      createDispatcherShellStore(),
      { onboarding: () => null },
    );
    assert.equal(typeof component, "function");
  });

  it("a full apply() over a scope-less runtime still registers the page (degrade, no crash)", () => {
    const ctx = createOnboardingCtx(undefined);
    assert.doesNotThrow(() => apply(ctx));
    const main = ctx.injects.find((record) => record.parent === "main");
    assert.ok(main, "main page registration missing");
    assert.equal(main.entries.length, 1);
  });
});
