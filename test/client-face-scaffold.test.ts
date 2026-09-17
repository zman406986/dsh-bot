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

describe("client face scaffold — package declaration (Finding 4)", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    name: string;
    dsh?: { client?: { platform?: string; external?: string[] } };
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

  it("binds the client services via the Cordis-level inject list", () => {
    assert.deepEqual([...clientInject], ["slots", "locale"]);
  });
});

describe("client face scaffold — locale dictionary (Finding 6)", () => {
  it("ships en and zh faces with identical key sets and string values", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    const keys = Object.keys(localeDictionary.en).sort();
    // Roster copy (tickets 21 + 27 + 28), the ticket-32 activation presence
    // hint, the ticket-24 toolview copy, the ticket-38 capsule chip copy,
    // the ticket-39 activation-row copy, and the ticket-40 action-wiring
    // copy (stop message, failure lines, per-row steer affordance).
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
      "capsule.dot.active",
      "capsule.dot.dormant",
      "capsule.dot.error",
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
      "toolview.degraded",
      "toolview.field.attachments",
      "toolview.field.delivered",
      "toolview.field.outcome",
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
  /** The shell.overlay inject record, whatever the module also registers. */
  function overlayInject(ctx: ReturnType<typeof createClientCtx>) {
    const record = ctx.injects.find(
      (candidate) => candidate.parent === SHELL_OVERLAY_SLOT,
    );
    assert.ok(record, "shell.overlay inject missing");
    return record;
  }

  it("registers the locale namespace and exactly one shell.overlay entry", () => {
    const ctx = createClientCtx();
    apply(ctx);

    // Locale namespace registered with the shipped dictionary.
    assert.ok(ctx.locales.has("multitask-dispatcher"));
    assert.deepEqual(
      validateLocaleDictionary(ctx.locales.get("multitask-dispatcher")),
      [],
    );

    // Ticket 24 adds a second inject (tool.call.toolview); this scaffold
    // contract stays: exactly one shell.overlay entry, parented here.
    const overlay = overlayInject(ctx);
    assert.equal(overlay.entries.length, 1);
    const entry = overlay.entries[0];
    assert.ok(entry);
    assert.deepEqual(entry.options, rosterOverlayRegistration());
    assert.equal(typeof entry.component, "function");
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
    assert.equal(ctx.injects.length, 2);
    assert.equal(overlayInject(ctx).entries.length, 1);
    assert.ok(ctx.locales.has(LOCALE_NAMESPACE));

    ctx.runFiberTeardown();
    assert.equal(ctx.injects.length, 0);
    assert.equal(ctx.injects[0]?.entries.length ?? 0, 0);
    assert.equal(ctx.locales.has(LOCALE_NAMESPACE), false);

    // A fresh fiber (post-HMR apply) registers everything again.
    apply(ctx);
    assert.equal(ctx.injects.length, 2);
    assert.equal(overlayInject(ctx).entries.length, 1);
    assert.ok(ctx.locales.has(LOCALE_NAMESPACE));
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
