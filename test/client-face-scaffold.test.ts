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
import {LOCALE_NAMESPACE, localeDictionary, SHELL_OVERLAY_SLOT, validateLocaleDictionary, type SlotRegistrationOptions} from "../src/client/overlay.js";
import {CLIENT_MODULE_ID} from "../src/client/wrapper.js";
import { buildClient } from "../scripts/build-client.js";
import {ROOT_FRAME_SLOT} from "../src/client/shell-mount.js";
import {SIDEBAR_TRAILING_SLOT} from "../src/client/session-kind.js";

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
 *   active inject controller, runs the SHIPPED SlotCore collision rule, and
 *   returns its exact disposer;
 * - `ctx.locale.register(ns, dict)` records the namespace; `bind(ns)` curries
 *   a `t` seat over the recorded dictionary.
 *
 * Ticket 86 (2026-09-19): the slots fake now models the shipped SlotCore
 * register rule, the same semantics the ticket-85 fix taught the
 * shell-mount/coexistence fakes — ONE global cell per slot name, entries kept
 * sorted ASCENDING by `(priority ?? 0)`, and a same-`(priority ?? 0)`
 * registration along the entry's identity axis THROWS with the host's exact
 * wording. Before this, the fake accepted a no-priority `root` register: the
 * pre-85 cutover shipped exactly that and the live loader entry died (pass 3).
 *
 * Verified against the installed 0.1.5-rc.1 client (read-only,
 * `dsh-web-frontend/dist/assets/index-BKQ_L1z6.js`, minified SlotCore):
 * - `a = t.priority ?? 0` — an absent priority defaults to ZERO;
 * - `single`: `entries.find(g => (g.options.priority ?? 0) === a)` → throw
 *   `single slot "X" already has a registration at priority N — register at a
 *   different priority to shadow it (lowest renders)`;
 * - `keyed`: `requires options.key`, then a same-`key`+same-priority entry
 *   throws `keyed slot "X" already has an entry for key "K" at priority N …`;
 * - `list`: `requires options.id`, then a same-`id`+same-priority entry
 *   throws `list slot "X" already has an entry with id "I" at priority N …`;
 * - entries sort at insert (`(m.options.priority ?? 0) - (g.options.priority
 *   ?? 0)`) and the outlet renders the first live entry — "lowest renders"
 *   (`dsh-client-ui-renderer/lib/types/client/registry.d.ts:156-164`).
 *
 * The registrant suffix (` (registered by X)`) is omitted: the fake has no
 * registrant identity. `kind` is inferred from the options shape (key →
 * keyed, id → list, else single) because the shipped kind comes from the slot
 * catalog, which has no offline stand-in.
 */
function createClientCtx() {
  const locales = new Map<string, unknown>();
  const cells = new Map<
    string,
    Array<{
      options: Record<string, unknown>;
      component: unknown;
      dispose(): void;
    }>
  >();
  const injects: Array<{
    parent: string;
    entries: Array<{
      options: Record<string, unknown>;
      component: unknown;
      dispose(): void;
    }>;
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
        const record = { parent, entries: [] as typeof injects[number]["entries"] };
        injects.push(record);
        try {
          callback();
        } catch (error) {
          // A throwing registration leaves no half-installed declaration;
          // the host's effect failure unwinds the same way.
          const at = injects.indexOf(record);
          if (at >= 0) injects.splice(at, 1);
          throw error;
        }
        const controller = () => {
          const at = injects.indexOf(record);
          if (at >= 0) injects.splice(at, 1);
          for (const entry of record.entries.splice(0)) entry.dispose();
        };
        injectControllers.push(controller);
        return controller;
      },
      register(rawOptions: unknown, component: unknown) {
        const owner = injects.at(-1);
        assert.ok(owner, "slots.register outside of slots.inject (fake)");
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
        // The shipped kind (single/keyed/list) comes from the slot catalog and
        // also decides which identity option is REQUIRED (`options.key` for
        // keyed, `options.id` for list); offline the catalog has no stand-in,
        // so the kind is inferred from the options shape and the `requires
        // options.key`/`requires options.id` preconditions are not modeled.
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
          // Host wording per kind, verbatim (the registrant suffix omitted).
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
        const entry = {
          options: { ...rawOptions } as Record<string, unknown>,
          component,
          dispose: () => {},
        };
        cell.push(entry);
        // Insert-time ascending `(priority ?? 0)` sort — the shipped order.
        cell.sort(
          (a, b) =>
            ((a.options.priority as number | undefined) ?? 0) -
            ((b.options.priority as number | undefined) ?? 0),
        );
        entry.dispose = () => {
          const ownerAt = owner.entries.indexOf(entry);
          if (ownerAt >= 0) owner.entries.splice(ownerAt, 1);
          const cellAt = cell.indexOf(entry);
          if (cellAt >= 0) cell.splice(cellAt, 1);
        };
        owner.entries.push(entry);
        return entry.dispose;
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
    cells,
    runFiberTeardown() {
      for (const dispose of [...effectDisposers, ...injectControllers]) {
        dispose();
      }
    },
  };
  return ctx as typeof ctx & ClientContext & {
    runFiberTeardown(): void;
    cells: Map<
      string,
      Array<{ options: Record<string, unknown>; component: unknown }>
    >;
  };
}

/** The service faces the host guards with the inject requirement (ticket 84). */
const CLIENT_SERVICE_FACES = new Set([
  "slots",
  "locale",
  "sessions",
  "remote",
  // Ticket 102b: the nested transaction face is its own entry — the resolver
  // matches inject entries by exact string and never dot-splits, so the
  // parent `remote` does not authorize this read.
  "remote.commands",
  "conversation",
  "configForms",
  // A shipped face this module does not read: the guard must still refuse it
  // when read bare (the negative control below).
  "layout",
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

  it("registers under the scanned package name", () => {
    assert.equal(CLIENT_MODULE_ID, pkg.name);
  });
});

describe("client face scaffold — locale dictionary (Finding 6)", () => {
  it("ships en and zh faces with identical key sets and string values", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    const keys = Object.keys(localeDictionary.en).sort();
    // Roster copy (tickets 21 + 27 + 28), the ticket-32 activation presence
    // hint, the ticket-24 toolview copy, the ticket-40 per-row steer
    // affordance copy, the ticket-70 send_peer row labels, the ticket-47
    // settings-card copy (chrome, save/discard, and one label/hint pair per
    // schema field), and the ticket-68 onboarding beat copy (five beats +
    // the step/next/done/skip/save-failed chrome). (The capsule-era copy
    // keys left with the capsule's deletion — ticket 89, 2026-09-19.)
    assert.deepEqual(keys, [
      "activation.presence-hint",
      "indicator.dispatcher",
      "indicator.team-leader",
      "indicator.worker",
      "roster.activity.toolcalls.one",
      "roster.activity.toolcalls.other",
      "roster.empty",
      "roster.fact.started",
      "roster.finished.count.one",
      "roster.finished.count.other",
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
      "settings.card.field.enabled.hint",
      "settings.card.field.enabled.label",
      "settings.card.field.inboxDir.hint",
      "settings.card.field.inboxDir.label",
      "settings.card.field.inboxEnabled.hint",
      "settings.card.field.inboxEnabled.label",
      "settings.card.field.inboxRescanIntervalMs.hint",
      "settings.card.field.inboxRescanIntervalMs.label",
      "settings.card.field.microcompactEnabled.hint",
      "settings.card.field.microcompactEnabled.label",
      "settings.card.field.wakeCoalesceWindowMs.hint",
      "settings.card.field.wakeCoalesceWindowMs.label",
      "settings.card.invalid",
      "settings.card.overridden",
      "settings.card.readonly",
      "settings.card.reset",
      "settings.card.save",
      "settings.card.title",
      "settings.card.unsaved",
      "shell.approval.failed",
      "shell.approval.no-channel",
      "shell.approval.secret-promise",
      "shell.approval.submitted",
      "shell.approval.target",
      "shell.approval.unavailable",
      "shell.conv.attachment-only",
      "shell.conv.empty",
      "shell.conv.interrupted",
      "shell.conv.message",
      "shell.conv.more",
      "shell.conv.no-channel",
      "shell.conv.role-assistant",
      "shell.conv.role-peer",
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
      "shell.dispatch.refused",
      "shell.dispatch.refused-generic",
      "shell.dispatch.started",
      "shell.dispatch.started-generic",
      "shell.empty",
      "shell.noselection",
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
      "shell.row.copy-id",
      "shell.row.finished.one",
      "shell.row.finished.other",
      "shell.row.needs-you.one",
      "shell.row.needs-you.other",
      "shell.row.presence-unavailable",
      "shell.row.working.one",
      "shell.row.working.other",
      "shell.seat.failed",
      "shell.sidebar.label",
      "shell.title",
      "status.adjusting",
      "status.done",
      "status.failed",
      "status.starting",
      "status.stopped",
      "status.working",
      "toolview.await.done",
      "toolview.await.failed",
      "toolview.await.gone",
      "toolview.await.pending",
      "toolview.await.refused",
      "toolview.await.released",
      "toolview.await.stopped",
      "toolview.await.working",
      "toolview.cause.already-settled",
      "toolview.cause.duplicate-stream-key",
      "toolview.cause.failed",
      "toolview.cause.host-refused",
      "toolview.cause.inbox-full",
      "toolview.cause.invalid-args",
      "toolview.cause.invalid-envelope",
      "toolview.cause.invalid-timeout",
      "toolview.cause.message-id-reuse",
      "toolview.cause.no-delivery-channel",
      "toolview.cause.not-awaitable",
      "toolview.cause.not-running",
      "toolview.cause.rate-limited",
      "toolview.cause.self-target",
      "toolview.cause.send-failed",
      "toolview.cause.todo-already-linked",
      "toolview.cause.too-many-waits",
      "toolview.cause.unknown-agent",
      "toolview.cause.unknown-dispatcher",
      "toolview.cause.unknown-todo",
      "toolview.cause.unknown-todo-id",
      "toolview.cause.unknown-worker",
      "toolview.check.pending",
      "toolview.check.refused",
      "toolview.check.summary.none",
      "toolview.check.summary.one",
      "toolview.check.summary.other",
      "toolview.degraded",
      "toolview.deliver.done",
      "toolview.deliver.pending",
      "toolview.deliver.recorded",
      "toolview.deliver.refused",
      "toolview.detail.call",
      "toolview.detail.dispatcher",
      "toolview.detail.elapsed",
      "toolview.detail.message",
      "toolview.detail.mode",
      "toolview.detail.reason",
      "toolview.detail.settled",
      "toolview.detail.status",
      "toolview.detail.stream",
      "toolview.detail.target",
      "toolview.detail.todo",
      "toolview.detail.transcript",
      "toolview.detail.waited",
      "toolview.detail.worker",
      "toolview.details",
      "toolview.dispatcher.pending",
      "toolview.dispatcher.pending-generic",
      "toolview.dispatcher.refused",
      "toolview.dispatcher.refused-generic",
      "toolview.dispatcher.summoned",
      "toolview.dispatcher.summoned-generic",
      "toolview.fact.attachments.one",
      "toolview.fact.attachments.other",
      "toolview.fact.dormant",
      "toolview.fact.keeps-running",
      "toolview.fact.priority",
      "toolview.fact.released-stream",
      "toolview.fact.todo-completed",
      "toolview.fact.todo-marked-done",
      "toolview.fact.todo-marked-done-ref",
      "toolview.fact.turn-stopped",
      "toolview.fact.user-spoke",
      "toolview.fact.via-peer",
      "toolview.fact.via-steer",
      "toolview.fact.waited",
      "toolview.message.pending",
      "toolview.message.refused",
      "toolview.message.sent",
      "toolview.peer.pending",
      "toolview.peer.refused",
      "toolview.peer.sent",
      "toolview.spawn.pending",
      "toolview.spawn.pending-generic",
      "toolview.spawn.refused",
      "toolview.spawn.refused-generic",
      "toolview.spawn.started",
      "toolview.spawn.started-generic",
      "toolview.steer.pending",
      "toolview.steer.refused",
      "toolview.steer.sent",
      "toolview.stop.pending",
      "toolview.stop.refused",
      "toolview.stop.released",
      "toolview.stop.stopped",
      "toolview.subject.agent",
      "toolview.subject.dispatcher",
      "toolview.subject.todo",
      "toolview.subject.worker",
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

  it("the settings-card description advertises no removed permission-request timeout", () => {
    // Ticket 193 / ADR-0033: `accessRequestTimeoutMs` and its card row are
    // gone, so the shared description — rendered by the Plugins row summary
    // and the available-configuration page header — must not promise a wait
    // on an unanswered permission request in either face.
    const descriptions = {
      en: localeDictionary.en["settings.card.description"] ?? "",
      zh: localeDictionary.zh["settings.card.description"] ?? "",
    };
    for (const [face, text] of Object.entries(descriptions)) {
      assert.ok(text.length > 0, `${face} description is empty`);
      assert.doesNotMatch(
        text,
        /permission|timeout|unanswered/i,
        `${face} description still advertises the removed permission-request timeout`,
      );
      assert.doesNotMatch(
        text,
        /权限|超时|未获答复/,
        `${face} description still advertises the removed permission-request timeout`,
      );
    }
  });
});

describe("client face scaffold — apply over fake client seams", () => {
  it("registers the locale namespace and NO shell.overlay entry (capsule retired)", () => {
    const ctx = createClientCtx();
    apply(ctx);

    // Locale namespace registered with the shipped dictionary.
    assert.ok(ctx.locales.has("dsh-bot"));
    assert.deepEqual(
      validateLocaleDictionary(ctx.locales.get("dsh-bot")),
      [],
    );

    // Ticket 24 adds a second inject (tool.call.toolview) and ticket 47 a
    // third (plugins.row.config); the ticket-78 CUTOVER (2026-09-19)
    // retires the additive overlay entries — the capsule (ticket 38) and
    // the staging launcher chip — so NO `shell.overlay` inject remains.
    // The `main` page and `root` election are not registered either: stock
    // dsh is the primary UI and is never displaced — only additive slots
    // register. The removed client settings-scope watch left with dsh 0.2.1.
    const overlay = ctx.injects.find(
      (candidate) => candidate.parent === SHELL_OVERLAY_SLOT,
    );
    assert.equal(overlay, undefined, "no shell.overlay inject post-cutover");
  });

  it("the one layout seat is the trailing sidebar cell, never the leading one", () => {
    // ADR-0024's rider licenses exactly one additive registration; the
    // 2026-11-06 human ruling moved it to `sidebar.session.row.trailing`
    // because `sidebar.session.row.leading` is replaced by the row's own
    // status dot whenever the row is not idle
    // (`dsh-client-ui-workspace/lib/client.js:2608`), while the trailing seat
    // renders beside that dot (`:2634`, contract
    // `.../contract/slots.d.ts:148-161`).
    const ctx = createClientCtx();
    apply(ctx);

    const sidebar = ctx.injects.filter((candidate) =>
      candidate.parent.startsWith("sidebar.session.row."),
    );
    assert.deepEqual(
      sidebar.map((candidate) => candidate.parent),
      [SIDEBAR_TRAILING_SLOT],
      "exactly one sidebar-row seat, and it is the trailing one",
    );
    assert.equal(
      ctx.injects.some(
        (candidate) => candidate.parent === "sidebar.session.row.leading",
      ),
      false,
      "the status-gated leading cell is left to the product",
    );
    assert.equal(sidebar[0]?.entries.length, 1);
  });

  it("fiber teardown (HMR/unload) reverses the namespace and the entry; re-apply restores", () => {
    const ctx = createClientCtx();
    apply(ctx);
    // Three declaration waits: tool.call.toolview (ticket 24),
    // plugins.row.config (ticket 47), and the dispatcher sidebar glyph
    // (ticket 123). The ticket-140 header chip was removed 2026-10-28. The
    // `main` page and the `root` election are not composed; the capsule +
    // launcher shell.overlay injects retired at the cutover.
    assert.equal(ctx.injects.length, 3);
    assert.ok(ctx.locales.has(LOCALE_NAMESPACE));

    ctx.runFiberTeardown();
    assert.equal(ctx.injects.length, 0);
    assert.equal(ctx.injects[0]?.entries.length ?? 0, 0);
    assert.equal(ctx.locales.has(LOCALE_NAMESPACE), false);

    // A fresh fiber (post-HMR apply) registers everything again.
    apply(ctx);
    assert.equal(ctx.injects.length, 3);
    assert.ok(ctx.locales.has(LOCALE_NAMESPACE));
  });
});

describe("client face scaffold — shipped slot register semantics (ticket 86)", () => {
  it("apply leaves a seeded `root` cell untouched — stock dsh keeps its frame (ticket 99, ADR-0021)", () => {
    // The shipped AppFrame holds the `root` cell at ITS effective
    // `priority ?? 0` (no priority declared — dsh-client-ui-layout
    // lib/client.js:524-531). Until ticket 99 the composition registered a
    // shadowing frame at priority -1 (ticket 85) over exactly this seed;
    // ADR-0021 retires the election: stock dsh is the primary UI and is
    // NEVER displaced, so after `apply` the cell must hold ONLY the shipped
    // frame, in its original shape.
    const ctx = createClientCtx();
    ctx.slots.inject(ROOT_FRAME_SLOT, () =>
      ctx.slots.register({ name: ROOT_FRAME_SLOT }, "shipped-app-frame"),
    );

    assert.doesNotThrow(() => apply(ctx));

    const cell = ctx.cells.get(ROOT_FRAME_SLOT) ?? [];
    assert.equal(cell.length, 1, "the shipped frame stands alone in the cell");
    assert.equal(cell[0]?.options.name, ROOT_FRAME_SLOT);
    assert.equal(cell[0]?.options.priority, undefined, "the shipped frame declares no priority");
    assert.equal(cell[0]?.component, "shipped-app-frame");
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
    // The composition makes no runtime inject request at all: the removed
    // client settings-scope watch left with dsh 0.2.1, and the settings page's
    // form arrives through the slot owner props.
    assert.deepEqual(ctx.injectRequests, []);
  });

  it("declares only the faces the LIVE entries read (the dormant shell resolves its own)", () => {
    // The live composition is the locale namespace, the nine tool views, the
    // settings card, and the sidebar glyph: all of them read `slots`/`locale`
    // only. A module-level requirement on sessions/remote/conversation/
    // configForms held those entries hostage to clients that may be absent
    // (the live defect this pin prevents), so those faces must NOT appear.
    assert.deepEqual([...clientInject].sort(), ["locale", "slots"]);
    // And the strict host (where every undeclared read throws) still applies
    // without any of those providers: nothing in `apply` touches them.
    const ctx = createStrictHostCtx();
    assert.doesNotThrow(() => apply(ctx));
    assert.equal(ctx.injects.length, 3, "toolviews + settings card + glyph");
  });

  // (The staging launcher's layout-cell test left with the launcher's
  // deletion — ticket 89, 2026-09-19.)
});

describe("client face scaffold — built bundle registers through the module loader (Finding 4)", () => {
  it("the built bundle is a CJS module-loader factory with react external", async () => {
    // A bundle not shaped like this simply never loads in the host, so this
    // is the install gate for the whole client face.
    const bundle = await buildClient();
    assert.ok(bundle.startsWith("window.__ModuleLoader__.load({"));
    assert.match(bundle, /\n\tid: "dsh-multitask-dispatcher",/);
    assert.match(bundle, /\n\tfactory: \(require\) => \{/);
    assert.ok(bundle.trimEnd().endsWith("return module.exports;\n\t}\n});"));
    assert.ok(bundle.includes('require("react/jsx-runtime")'), "react/jsx-runtime must be external");
    assert.ok(!/\bimport\s/.test(bundle), "ESM imports survive — the loader is CJS-only");
    // The module exports the Cordis plugin face.
    assert.match(bundle, /inject: \(\) => inject/);
    assert.match(bundle, /apply: \(\) => apply/);
  });
});
