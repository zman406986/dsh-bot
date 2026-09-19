/**
 * Ticket 20 — client-face scaffold (design-16 §4.2 prerequisite; Findings
 * 4/5/6 of docs/research/dsh-plugin-ui-patterns.md).
 *
 * Offline only (S8): package-declaration assertions, pure
 * registration-options / locale-dictionary checks, a fake client ctx (slots,
 * locale, effect seams faked with the shipped Cordis effect semantics — same
 * idiom as test/activation-lifecycle.test.ts faking AdapterContext), and an
 * in-process esbuild run proving the built bundle registers through
 * `window.__ModuleLoader__.load({id, factory})` with react kept external.
 * No real Cordis, no browser, no network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { apply, inject as clientInject } from "../src/client/index.js";
import type { ClientContext } from "../src/client/context.js";
import {
  LOCALE_NAMESPACE,
  ROSTER_ENTRY_ID,
  localeDictionary,
  rosterOverlayRegistration,
  SHELL_OVERLAY_SLOT,
  validateLocaleDictionary,
  type SlotRegistrationOptions,
} from "../src/client/overlay.js";
import { CLIENT_MODULE_ID, wrapClientBundle } from "../src/client/wrapper.js";
import { buildClient } from "../scripts/build-client.js";
import {
  createShellLauncherLayout,
  SHELL_PAGE_KEY,
} from "../src/client/shell-mount.js";

/**
 * Fake the client face the way the shipped Cordis runtime behaves:
 *
 * - `ctx.effect(execute, label?)` runs `execute` immediately and collects the
 *   returned function as the unload disposer (cordis lib/index.js:1168,
 *   1141-1143);
 * - `ctx.slots.inject(parent, cb)` installs an effect on the caller's fiber;
 *   offline there is no shipped layout, so the fake invokes the callback once
 *   (the "declaration now exists" moment) and hands the test a controller
 *   disposer representing fiber teardown;
 * - `ctx.slots.register(options, component)` records the entry owned by the
 *   active inject controller and returns its exact disposer;
 * - `ctx.locale.register(ns, dict)` records the namespace; `bind(ns)` curries
 *   a `t` seat over the recorded dictionary.
 */
function createClientCtx() {
  const locales = new Map<string, unknown>();
  const injects: Array<{
    parent: string;
    entries: Array<{ options: SlotRegistrationOptions; component: unknown }>;
  }> = [];
  const injectControllers: Array<() => void> = [];
  const effectDisposers: Array<() => void> = [];

  const ctx = {
    effect(execute: () => unknown, label?: string) {
      void label;
      const returned = execute();
      const disposer: () => void =
        typeof returned === "function" ? returned : () => {};
      effectDisposers.push(disposer);
      return () => {};
    },
    slots: {
      inject(parent: string, callback: () => unknown) {
        const record = { parent, entries: [] };
        injects.push(record);
        callback();
        const controller = () => {
          const at = injects.indexOf(record);
          if (at >= 0) injects.splice(at, 1);
          record.entries.length = 0;
        };
        injectControllers.push(controller);
        return controller;
      },
      register(options: SlotRegistrationOptions, component: unknown) {
        const owner = injects.at(-1);
        assert.ok(owner, "slots.register outside of slots.inject (fake)");
        const entry = { options, component };
        owner.entries.push(entry);
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
    // Test surface.
    locales,
    injects,
    runFiberTeardown() {
      for (const dispose of [...effectDisposers, ...injectControllers]) {
        dispose();
      }
    },
  };
  return ctx as typeof ctx & ClientContext & { runFiberTeardown(): void };
}

/** The service faces the host guards with the inject requirement (ticket 84). */
const CLIENT_SERVICE_FACES = new Set([
  "slots",
  "locale",
  "sessions",
  "remote",
  "conversation",
  "layout",
  "settingsScope",
]);

/**
 * The scaffold fake under the REAL host guard semantics (ticket 84): the
 * module context is a proxy that throws `cannot get property "X" without
 * inject` when a plugin reads a service property outside its declared
 * inject list (cordis `src/reflect.ts:144`; declared reads resolve through
 * the fiber's inject snapshot, `fiber.ts:647`), and `ctx.inject([...], cb)`
 * runs the callback with a CHILD context whose listed services are declared
 * (cordis `registry.ts:300-302` — a child plugin fiber; a disposer the
 * callback returns is collected as that fiber's teardown). `providers`
 * stands in for the shipped services; a declared face with no provider
 * reads `undefined`, exactly like an optional structural face offline.
 */
function createStrictHostCtx(providers: Record<string, unknown> = {}) {
  const base = createClientCtx();
  const declared = new Set<string>([...clientInject]);
  const injectRequests: Array<readonly string[]> = [];
  const injectDisposers: Array<() => void> = [];
  const guard = (
    target: Record<string, unknown>,
    allowed: Set<string>,
  ): Record<string, unknown> =>
    new Proxy(target, {
      get(target, prop, receiver) {
        if (
          typeof prop === "string" &&
          CLIENT_SERVICE_FACES.has(prop) &&
          !allowed.has(prop)
        ) {
          throw new Error(`cannot get property "${prop}" without inject`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  const moduleAllowed = new Set(declared);
  for (const name of declared) {
    // Overlay ONLY the faces a provider stands in for; the fake's own
    // slots/locale machinery must survive.
    if (providers[name] !== undefined) {
      (base as Record<string, unknown>)[name] = providers[name];
    }
  }
  (base as Record<string, unknown>).inject = (
    services: readonly string[],
    cb: (child: unknown) => unknown,
  ) => {
    injectRequests.push([...services]);
    const returned = cb(
      guard(
        { ...providers },
        new Set<string>([...declared, ...services]),
      ),
    );
    if (typeof returned === "function") injectDisposers.push(returned);
    return {};
  };
  const ctx = guard(
    base as unknown as Record<string, unknown>,
    moduleAllowed,
  ) as unknown as typeof base & { injectRequests: Array<readonly string[]> };
  const baseTeardown = base.runFiberTeardown.bind(base);
  (ctx as { runFiberTeardown(): void }).runFiberTeardown = () => {
    baseTeardown();
    for (const dispose of injectDisposers.reverse()) dispose();
  };
  ctx.injectRequests = injectRequests;
  return ctx;
}

describe("client face scaffold — package declaration (Finding 4)", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    name: string;
    dsh?: {
      client?: {
        platform?: string;
        inject?: string[];
        immediately?: boolean;
        external?: string[];
      };
    };
    exports: Record<string, unknown>;
    files: string[];
  };

  it("declares the web client record with react externals", () => {
    assert.equal(pkg.dsh?.client?.platform, "web");
    // Static seed words on the dsh web side — no boot-graph edge, never
    // bundled into the plugin script.
    assert.deepEqual(pkg.dsh?.client?.external, [
      "react",
      "react/jsx-runtime",
    ]);
  });

  it("declares dsh.client.inject after the shipped idiom; no immediately flag (ticket 34)", () => {
    // Boot-graph edges ordering our bundle after its service providers'
    // bundles (dsh-client-modules `arriveGraphRow`). NOTE (ticket 84): this
    // manifest list orders BUNDLE ARRIVAL only — it does not authorize
    // service reads. The service-level declaration is the module's exported
    // Cordis `inject` array (asserted below); `slots` ← renderer and
    // `locale` ← locale remain the only bundles our factory's require graph
    // needs edges for.
    assert.deepEqual(pkg.dsh?.client?.inject, [
      "@deepseek-ai/dsh-client-ui-renderer",
      "@deepseek-ai/dsh-client-locale",
    ]);
    // Bootstrap tier is the shipped renderer/locale pair only; no ordinary
    // plugin package declares dsh.client.immediately (shipped 0.1.5-rc.1 idiom).
    assert.equal(pkg.dsh?.client?.immediately, undefined);
  });

  it("adds exports['./client'] and ships the client dir; host export untouched", () => {
    assert.equal(pkg.exports["./client"], "./client/index.js");
    assert.deepEqual(pkg.exports["."], {
      types: "./lib/index.d.ts",
      import: "./lib/index.js",
    });
    assert.ok(pkg.files.includes("client"));
  });

  it("registers under the scanned package name", () => {
    assert.equal(CLIENT_MODULE_ID, pkg.name);
  });
});

describe("client face scaffold — shell.overlay entry builder (Finding 5, design-16 §5)", () => {
  it("builds the roster options for the documented list slot (ticket 21)", () => {
    assert.deepEqual(rosterOverlayRegistration(), {
      name: "shell.overlay",
      id: "multitask-dispatcher-roster",
      order: -10,
      locale: "multitask-dispatcher",
    });
  });

  it("uses only a dsh-owned shipped slot and a prefixed id — never a forbidden surface", () => {
    assert.equal(SHELL_OVERLAY_SLOT, "shell.overlay");
    assert.match(ROSTER_ENTRY_ID, /^multitask-dispatcher-/);
    assert.equal(LOCALE_NAMESPACE, "multitask-dispatcher");
    for (const forbidden of [
      "root",
      "main",
      "sidebar.right.pane.tab",
      "conversation.approval.detail",
    ]) {
      assert.notEqual(SHELL_OVERLAY_SLOT, forbidden);
      assert.notEqual(rosterOverlayRegistration().id, forbidden);
    }
  });

  it("declares every service face the module reads (ticket 84)", () => {
    // The context proxy throws `cannot get property "X" without inject` on
    // any service property the module's inject list does not declare, at
    // read time, wherever the read happens (live pass 2's launcher kill).
    // Declared: slots ← ui-renderer, locale ← dsh-client-locale, sessions ←
    // dsh-client-ui-session (the shipped provider itself exports
    // `inject = ["sessions", "slots"]`), remote ← dsh-api-gateway,
    // conversation ← dsh-client-ui-conversation. `layout` and
    // `settingsScope` are deliberately NOT declared — genuinely optional
    // faces reached through the runtime `ctx.inject([...])` wrapper instead
    // (tickets 46/84); a hard declaration would hold the module PENDING
    // when they are absent.
    assert.deepEqual([...clientInject], [
      "slots",
      "locale",
      "sessions",
      "remote",
      "conversation",
    ]);
  });
});

describe("client face scaffold — locale dictionary (Finding 6)", () => {
  it("ships en and zh faces with identical key sets and string values", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    const keys = Object.keys(localeDictionary.en).sort();
    // Roster copy (tickets 21 + 27 + 28), the ticket-32 activation presence
    // hint, the ticket-24 toolview copy, the ticket-38 capsule chip copy,
    // the ticket-39 activation-row copy, the ticket-40 action-wiring copy
    // (stop message, failure lines, per-row steer affordance), the
    // ticket-41 deliverables-line copy, the ticket-42 footer copy
    // (flag provenance + copy-only Settings hint), the ticket-70 send_peer
    // row labels, the ticket-47
    // settings-card copy (chrome, save/discard, and one label/hint pair per
    // schema field), and the ticket-68 onboarding beat copy (five beats +
    // the step/next/done/skip/save-failed chrome).
    assert.deepEqual(keys, [
      "activation.presence-hint",
      "capsule.action.no-channel",
      "capsule.action.not-available",
      "capsule.action.send-failed",
      "capsule.activation.pitch",
      "capsule.activation.start",
      "capsule.activation.stop",
      "capsule.chip.open",
      "capsule.chip.wake",
      "capsule.chip.workers",
      "capsule.collapse",
      "capsule.deliverables.collapse",
      "capsule.deliverables.count",
      "capsule.deliverables.expand",
      "capsule.deliverables.label",
      "capsule.dot.active",
      "capsule.dot.dormant",
      "capsule.dot.error",
      "capsule.footer.flag.off",
      "capsule.footer.flag.on",
      "capsule.footer.settings-hint",
      "capsule.stop.message",
      "roster.activity.toolcalls",
      "roster.blocked.credential",
      "roster.blocked.filesystem",
      "roster.blocked.network",
      "roster.blocked.other",
      "roster.blocked.tool",
      "roster.empty",
      "roster.finished.count",
      "roster.landed",
      "roster.loading",
      "roster.section.active",
      "roster.section.finished",
      "roster.section.needs-you",
      "roster.steer.button",
      "roster.steer.copy-fallback",
      "roster.steer.hint",
      "roster.title",
      "roster.unavailable",
      "settings.card.collapse",
      "settings.card.description",
      "settings.card.discard",
      "settings.card.expand",
      "settings.card.failed",
      "settings.card.field.accessRequestTimeoutMs.hint",
      "settings.card.field.accessRequestTimeoutMs.label",
      "settings.card.field.enabled.hint",
      "settings.card.field.enabled.label",
      "settings.card.invalid",
      "settings.card.overridden",
      "settings.card.readonly",
      "settings.card.reset",
      "settings.card.save",
      "settings.card.title",
      "settings.card.unsaved",
      // Ticket 81 (ADR-0020 slice 5): the approval cards' own chrome (the
      // option labels, location line, expired copy, and secret-stored
      // reassurance ride the projections as ticket 30's shipped copy —
      // never re-keyed here) plus the dispatch card's gate label.
      "shell.approval.failed",
      "shell.approval.no-channel",
      "shell.approval.secret-promise",
      "shell.approval.submitted",
      "shell.approval.target",
      "shell.approval.unavailable",
      // Ticket 77 (ADR-0020 slice 1): the wrapper shell's chrome copy.
      // Ticket 80 (ADR-0020 slice 4): the conversation pane's copy.
      "shell.conv.attachment-only",
      "shell.conv.empty",
      "shell.conv.interrupted",
      "shell.conv.more",
      "shell.conv.no-channel",
      "shell.conv.role-assistant",
      "shell.conv.role-user",
      "shell.conv.send",
      "shell.conv.send-failed",
      "shell.conv.sending",
      "shell.conv.tool-failed",
      "shell.conv.tool-running",
      "shell.conv.unavailable",
      "shell.conv.waiting",
      "shell.conv.working",
      "shell.conversation.pending",
      "shell.dispatch.gating",
      "shell.empty",
      "shell.noselection",
      // Ticket 68 (ADR-0018 in-scope area): the first-run onboarding beats.
      "shell.onboard.background.body",
      "shell.onboard.background.title",
      "shell.onboard.done",
      "shell.onboard.first.body",
      "shell.onboard.first.title",
      "shell.onboard.handoff.body",
      "shell.onboard.handoff.title",
      "shell.onboard.intro.body",
      "shell.onboard.intro.title",
      "shell.onboard.next",
      "shell.onboard.save-failed",
      "shell.onboard.skip",
      "shell.onboard.step",
      "shell.onboard.tools.body",
      "shell.onboard.tools.title",
      "shell.row.finished",
      "shell.row.needs-you",
      "shell.row.presence-unavailable",
      "shell.row.working",
      "shell.sidebar.label",
      "shell.title",
      "toolview.degraded",
      "toolview.field.attachments",
      "toolview.field.delivered",
      "toolview.field.outcome",
      "toolview.field.peer",
      "toolview.field.priority",
      "toolview.field.steer",
      "toolview.field.stream",
      "toolview.field.title",
      "toolview.field.todo",
      "toolview.field.worker",
    ]);
    assert.deepEqual(Object.keys(localeDictionary.zh).sort(), keys);
    assert.ok(localeDictionary.en["roster.title"]?.length > 0);
    assert.ok(localeDictionary.zh["roster.title"]?.length > 0);
  });

  it("rejects broken dictionaries with named problems", () => {
    assert.ok(validateLocaleDictionary(null).length > 0);
    assert.ok(validateLocaleDictionary({ en: {} }).length > 0);
    assert.ok(
      validateLocaleDictionary({ en: { a: "x" }, zh: { b: "y" } }).length > 0,
    );
    assert.ok(
      validateLocaleDictionary({
        en: { a: "x" },
        zh: { a: 3 as unknown as string },
      }).length > 0,
    );
  });
});

describe("client face scaffold — apply over fake client seams", () => {
  it("registers the locale namespace and NO shell.overlay entry (capsule retired)", () => {
    const ctx = createClientCtx();
    apply(ctx);

    // Locale namespace registered with the shipped dictionary.
    assert.ok(ctx.locales.has("multitask-dispatcher"));
    assert.deepEqual(
      validateLocaleDictionary(ctx.locales.get("multitask-dispatcher")),
      [],
    );

    // Ticket 24 adds a second inject (tool.call.toolview) and ticket 47 a
    // third (settings.plugin.item); the ticket-78 CUTOVER (2026-09-19)
    // retires the additive overlay entries — the capsule (ticket 38) and
    // the staging launcher chip — so NO `shell.overlay` inject remains:
    // the wrapper shell frame (the `root` election) is the product surface.
    const overlay = ctx.injects.find(
      (candidate) => candidate.parent === SHELL_OVERLAY_SLOT,
    );
    assert.equal(overlay, undefined, "no shell.overlay inject post-cutover");
  });

  it("slot entries declare the locale namespace so the t seat resolves", () => {
    const ctx = createClientCtx();
    apply(ctx);

    const t = ctx.locale.bind(LOCALE_NAMESPACE);
    assert.equal(t("roster.title"), localeDictionary.en["roster.title"]);
    assert.equal(t("roster.empty"), localeDictionary.en["roster.empty"]);
    assert.equal(t("roster.unavailable"), localeDictionary.en["roster.unavailable"]);
    assert.equal(t("unknown.key"), "unknown.key");
  });

  it("fiber teardown (HMR/unload) reverses the namespace and the entry; re-apply restores", () => {
    const ctx = createClientCtx();
    apply(ctx);
    // Four declaration waits: tool.call.toolview (ticket 24),
    // settings.plugin.item (ticket 47), `main` (ticket 78 staging, kept),
    // and `root` (the ticket-78 cutover's frame election). The capsule +
    // launcher shell.overlay injects retired at the cutover.
    assert.equal(ctx.injects.length, 4);
    assert.ok(ctx.locales.has(LOCALE_NAMESPACE));

    ctx.runFiberTeardown();
    assert.equal(ctx.injects.length, 0);
    assert.equal(ctx.injects[0]?.entries.length ?? 0, 0);
    assert.equal(ctx.locales.has(LOCALE_NAMESPACE), false);

    // A fresh fiber (post-HMR apply) registers everything again.
    apply(ctx);
    assert.equal(ctx.injects.length, 4);
    assert.ok(ctx.locales.has(LOCALE_NAMESPACE));
  });
});

describe("client face scaffold — host inject guard semantics (ticket 84)", () => {
  it("applies cleanly when undeclared service reads throw like the real host", () => {
    // The exact live-pass-2 regression, modeled offline: the pre-84
    // composition read `ctx.sessions`/`ctx.layout` bare, and the host's
    // context proxy threw `cannot get property "…" without inject`. Over a
    // context that throws the same way, the applied module must not touch
    // any face outside its declared inject list.
    const ctx = createStrictHostCtx();
    assert.doesNotThrow(() => apply(ctx));
    // The one optional face still watched is the settings namespace (the
    // roster/card/onboarding data path) — requested through the runtime
    // inject wrapper, never a bare read. The launcher's `layout` watch
    // retired with the ticket-78 cutover, so it is no longer requested.
    assert.deepEqual(ctx.injectRequests, [["settingsScope"]]);
  });

  it("declared faces resolve and undeclared faces throw with the host's message", () => {
    const sessions = { list: { getSnapshot: () => ({}) }, scope: () => undefined };
    const ctx = createStrictHostCtx({ sessions });
    // Declared face: the module-context read resolves to the provider.
    assert.equal(ctx.sessions, sessions);
    // Undeclared face: the host's exact guard message (cordis reflect.ts:144).
    assert.throws(
      () => (ctx as unknown as { layout: unknown }).layout,
      { message: 'cannot get property "layout" without inject' },
    );
  });

  it("the launcher click rides the layout cell to the honest outcomes", () => {
    // Pure cell behind the click (shell-mount): absent face → `no-layout`;
    // the wrapper-delivered face → `opened` with OUR page key; teardown
    // (face dropped) → `no-layout` again. Never a throw.
    const launcherLayout = createShellLauncherLayout(SHELL_PAGE_KEY);
    assert.deepEqual(launcherLayout.open(), { kind: "no-layout" });
    const calls: string[] = [];
    launcherLayout.setFace({ selectPanel: (id) => void calls.push(id) });
    assert.deepEqual(launcherLayout.open(), { kind: "opened" });
    assert.deepEqual(calls, [SHELL_PAGE_KEY]);
    launcherLayout.setFace(undefined);
    assert.deepEqual(launcherLayout.open(), { kind: "no-layout" });
  });
});

describe("client face scaffold — built bundle registers through the module loader (Finding 4)", () => {
  it("wrapClientBundle emits the shipped loader shell shape", () => {
    const out = wrapClientBundle("some-pkg", "let a = 1;\nmodule.exports = a;");
    assert.ok(out.startsWith("window.__ModuleLoader__.load({"));
    assert.match(out, /\n\tid: "some-pkg",/);
    assert.match(out, /\n\tfactory: \(require\) => \{/);
    assert.ok(out.includes("\t\tlet a = 1;"));
    assert.ok(out.trimEnd().endsWith("return module.exports;\n\t}\n});"));
  });

  it("esbuild output keeps react external and lands in the loader shell", async () => {
    const bundle = await buildClient();

    // Registration contract (Finding 4): id = package name, CJS factory.
    assert.ok(bundle.startsWith("window.__ModuleLoader__.load({"));
    assert.match(bundle, /\n\tid: "dsh-multitask-dispatcher",/);
    assert.match(bundle, /\n\tfactory: \(require\) => \{/);
    assert.ok(bundle.trimEnd().endsWith("return module.exports;\n\t}\n});"));

    // Externals resolved through the factory's require (platform seed), and
    // no ESM import statements survive (CJS-only, materialization-safe).
    assert.ok(bundle.includes('require("react/jsx-runtime")'));
    assert.ok(!bundle.includes('require("react-dom")'));
    assert.ok(!/\bimport\s/.test(bundle));

    // The module exports the Cordis plugin face: apply + inject.
    assert.match(bundle, /inject: \(\) => inject/);
    assert.match(bundle, /apply: \(\) => apply/);
  });
});
