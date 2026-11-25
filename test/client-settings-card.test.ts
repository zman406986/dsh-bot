/**
 * Ticket 47 — the dispatcher's configuration page.
 *
 * Two contracts are pinned here, both offline (S8: no real Cordis, no browser,
 * no DOM harness):
 *
 * 1. the REGISTRATION — exactly one keyed `plugins.row.config` entry, whose
 *    `key` is `<package name>#<row id>`. The Plugins page keys the cell that
 *    way (`dsh-client-ui-plugin-manager/lib/client.js:27-29`) and renders it
 *    only when the Host serves a settings namespace for the same row id, so a
 *    missing or renamed key is the exact live defect this ticket fixes — and it
 *    must fail here first;
 * 2. the FORM MODEL — the draft/stage/save semantics, including the honest
 *    degrades: no form renders nothing, a journal draft blocks the save,
 *    `overridden` is user-layer PRESENCE, one atomic `mutate` carries every
 *    staged write with the read revision, and a refused or dropped write keeps
 *    the drafts and reports the failure.
 *
 * Component rendering stays covered by build + typecheck; the card's stylesheet
 * token contract lives with the other surfaces in
 * `test/client-theme-tokens.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {apply, applyClientModule} from "../src/client/index.js";
import type {
  ClientContext,
  ConfigPageFormLike,
  ConfigFormSnapshotLike,
  SettingsPathOpLike,
} from "../src/client/context.js";
import {localeDictionary, validateLocaleDictionary} from "../src/client/overlay.js";
import { createRosterStore } from "../src/client/roster-store.js";
import { CLIENT_MODULE_ID } from "../src/client/wrapper.js";
import {SETTINGS_CARD_DESCRIPTION_KEY, SETTINGS_CARD_DISCARD_KEY, SETTINGS_CARD_EXPAND_KEY, SETTINGS_CARD_COLLAPSE_KEY, SETTINGS_CARD_FAILED_KEY, SETTINGS_CARD_FIELDS, SETTINGS_CARD_INVALID_KEY, SETTINGS_CARD_OVERRIDDEN_KEY, SETTINGS_CARD_READONLY_KEY, SETTINGS_CARD_RESET_KEY, SETTINGS_CARD_SAVE_KEY, SETTINGS_CARD_TITLE_KEY, SETTINGS_CARD_UNSAVED_KEY, PLUGINS_ROW_CONFIG_SLOT, createSettingsCardStore, describeSettingsCard, planSettingsCardWrites, settingsCardRegistration} from "../src/client/settings-card-store.js";
import { SETTINGS_NAMESPACE } from "../src/adapter/settings-section.js";
import { Config } from "../src/plugin.js";

/** The locale keys the card reads, exactly as the module exports them. */
const CARD_COPY_KEYS = [
  SETTINGS_CARD_TITLE_KEY,
  SETTINGS_CARD_DESCRIPTION_KEY,
  SETTINGS_CARD_EXPAND_KEY,
  SETTINGS_CARD_COLLAPSE_KEY,
  SETTINGS_CARD_UNSAVED_KEY,
  SETTINGS_CARD_READONLY_KEY,
  SETTINGS_CARD_SAVE_KEY,
  SETTINGS_CARD_DISCARD_KEY,
  SETTINGS_CARD_FAILED_KEY,
  SETTINGS_CARD_OVERRIDDEN_KEY,
  SETTINGS_CARD_RESET_KEY,
  SETTINGS_CARD_INVALID_KEY,
  ...SETTINGS_CARD_FIELDS.flatMap((spec) => [spec.labelKey, spec.hintKey]),
] as const;

/** A document the Host would resolve for our namespace (schema defaults). */
function documentWith(
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return { enabled: true, ...fields };
}

/**
 * A fake slot-supplied form modelling the SHIPPED contract
 * (`ConfigPageForm`, `slot-contract.d.ts:202-208`): `state` is the accepted
 * snapshot, `mutate(ops, revision)` is the one write path. Writes are recorded,
 * not applied — the test publishes the read-back explicitly so the recovery
 * path is exercised on purpose rather than by accident.
 */
function createForm(options?: { noMutate?: boolean }) {
  let state: ConfigFormSnapshotLike = { status: "loading" };
  const writes: Array<{
    ops: readonly SettingsPathOpLike[];
    revision: number | undefined;
  }> = [];
  /** Flip to make `mutate` throw, exercising the rejection path. */
  let throwOnWrite = false;
  /** Flip to make the Host refuse the mutation (`false`). */
  let refuse = false;
  /** Flip to make the read-back disagree with what was staged. */
  let dropWrites = false;

  const form: ConfigPageFormLike = {
    get state() {
      return state;
    },
    /**
     * A LIVE reader: unlike the shipped page form (a plain object), this fake
     * can read the accepted document at any moment, so read-back tests settle
     * synchronously. The plain-object shape the host actually hands in is
     * covered by the regressions for the live "Not saved" defect below.
     */
    getSnapshot() {
      return state;
    },
  };
  if (options?.noMutate !== true) {
    form.mutate = async (
      ops: readonly SettingsPathOpLike[],
      revision?: number,
    ) => {
      writes.push({ ops, revision });
      if (throwOnWrite) throw new Error("write rejected");
      return !refuse;
    };
  }

  return {
    form,
    writes,
    /** Publish the accepted snapshot the way the page owner would. */
    publish(next: ConfigFormSnapshotLike) {
      state = next;
    },
    /** Settle every recorded write into the published document (the read-back). */
    settle(readBack: ConfigFormSnapshotLike) {
      if (!dropWrites) state = readBack;
    },
    setThrowOnWrite(value: boolean) {
      throwOnWrite = value;
    },
    setRefuse(value: boolean) {
      refuse = value;
    },
    setDropWrites(value: boolean) {
      dropWrites = value;
    },
  };
}

/**
 * Fake client face: locale registry + slot injects + the declared services.
 *
 * Ticket 86 (2026-09-19): the slots fake carries the shipped SlotCore register
 * rule (one cell per slot name, `(priority ?? 0)` default, per-kind collision
 * throw) so an entry this module registers at a colliding priority fails here
 * instead of live. See test/client-face-scaffold.test.ts for the full citation
 * (`dsh-web-frontend/dist/assets/index-BKQ_L1z6.js`, minified SlotCore.register).
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
    effect(execute: () => unknown) {
      const returned = execute();
      const disposer = typeof returned === "function" ? returned : () => {};
      effectDisposers.push(disposer);
      return disposer;
    },
    slots: {
      inject(parent: string, callback: () => unknown) {
        const record = {
          parent,
          entries: [] as typeof injects[number]["entries"],
        };
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
      register(registration: unknown, component: unknown) {
        const owner = injects.at(-1);
        assert.ok(owner, "slots.register outside of slots.inject (fake)");
        return registerSlotEntry(cells, owner.entries, registration, component);
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
    locales,
    cells,
    /**
     * Run every collected disposer: the fiber's unload path. Ticket 86:
     * `slots.inject`'s controller is an effect on the caller's fiber, so the
     * fake disposes the declaration records with the effect disposers — the
     * host's own cascade.
     */
    runFiberTeardown() {
      for (const dispose of [...effectDisposers].reverse()) dispose();
      for (const dispose of [...injectControllers].reverse()) dispose();
    },
  };
  return ctx as typeof ctx & ClientContext;
}

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

/** The single `plugins.row.config` inject record, if any. */
function cardInject(ctx: ReturnType<typeof createClientCtx>) {
  return ctx.injects.find((record) => record.parent === PLUGINS_ROW_CONFIG_SLOT);
}

describe("settings card — registration is the pairing contract (ticket 47)", () => {
  it("apply registers exactly ONE plugins.row.config entry, keyed on our row", () => {
    const ctx = createClientCtx();
    apply(ctx);
    const record = cardInject(ctx);
    assert.ok(record, "no plugins.row.config inject — the config page would never render");
    assert.equal(record.entries.length, 1);
    const options = record.entries[0]?.options as
      | { name?: string; key?: string }
      | undefined;
    // Pinned against the host half's own namespace constant, not only against
    // the builder's output: a rename in the builder must not be able to take
    // the test with it.
    assert.equal(options?.name, "plugins.row.config");
    assert.equal(options?.key, `${CLIENT_MODULE_ID}#${SETTINGS_NAMESPACE}`);
    assert.deepEqual(options, settingsCardRegistration());
    assert.equal(typeof record.entries[0]?.component, "function");
  });

  it("the card's fields ARE the host schema's fields, in schema order", () => {
    // A field added to `Config` without a control would render an editable card
    // that silently hides part of its own namespace.
    const schemaFields = Object.keys(
      (Config as unknown as { dict: Record<string, unknown> }).dict,
    );
    assert.deepEqual(
      SETTINGS_CARD_FIELDS.map((spec) => spec.field),
      schemaFields,
    );
  });

  it("every card copy key exists in both faces, and the dictionaries stay parallel", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    for (const key of CARD_COPY_KEYS) {
      assert.equal(typeof localeDictionary.en[key], "string", `en missing ${key}`);
      assert.equal(typeof localeDictionary.zh[key], "string", `zh missing ${key}`);
      assert.ok((localeDictionary.en[key] ?? "").length > 0, `en empty ${key}`);
      assert.ok((localeDictionary.zh[key] ?? "").length > 0, `zh empty ${key}`);
    }
  });

});

describe("settings card — render model (ticket 47)", () => {
  const none = new Map<string, string>();

  it("an unavailable namespace renders nothing (honest, not an error surface)", () => {
    const view = describeSettingsCard({ status: "unavailable" }, none);
    assert.equal(view.available, false);
    assert.deepEqual(view.fields, []);
  });

  it("a served section seeds both drafts from the effective value", () => {
    const view = describeSettingsCard(
      { status: "ready", value: documentWith(), writable: true },
      none,
    );
    assert.equal(view.available, true);
    assert.equal(view.writable, true);
    assert.equal(view.valid, true);
    assert.deepEqual(
      view.fields.map((field) => [field.field, field.kind, field.text, field.checked]),
      [
        ["enabled", "boolean", "true", true],
        ["wakeCoalesceWindowMs", "number", "", null],
        // Ticket 113: the inbox trio — boolean, string (text input), number.
        ["inboxEnabled", "boolean", "", null],
        ["inboxDir", "string", "", null],
        ["inboxRescanIntervalMs", "number", "", null],
        // Ticket 124: microcompact is off by default and absent from the
        // served document → seeds empty, the schema default applies host-side.
        ["microcompactEnabled", "boolean", "", null],
      ],
    );
    assert.deepEqual(
      view.fields.map((field) => field.overridden),
      [
        false, false, false, false, false, false,
      ],
    );
  });

  it("`overridden` is user-layer PRESENCE, not a value comparison", () => {
    // An override equal to the composition default is still an override: it is
    // what tells the user the field was set on purpose and can be cleared.
    const view = describeSettingsCard(
      {
        status: "ready",
        value: documentWith(),
        base: { enabled: true },
        user: { enabled: true },
        writable: true,
      },
      none,
    );
    assert.deepEqual(
      view.fields.map((field) => [field.field, field.overridden]),
      [
        ["enabled", true],
        ["wakeCoalesceWindowMs", false],
        ["inboxEnabled", false],
        ["inboxDir", false],
        ["inboxRescanIntervalMs", false],
        ["microcompactEnabled", false],
      ],
    );
  });

  it("an absent write flag is NOT permission", () => {
    const view = describeSettingsCard({ status: "ready", value: documentWith() }, none);
    assert.equal(view.available, true);
    assert.equal(view.writable, false);
  });

  it("a staged draft is what renders — and an unreadable one is flagged", () => {
    const view = describeSettingsCard(
      { status: "ready", value: documentWith(), writable: true },
      new Map([["wakeCoalesceWindowMs", "soon"]]),
    );
    const timeout = view.fields.find(
      (field) => field.field === "wakeCoalesceWindowMs",
    );
    assert.equal(timeout?.text, "soon");
    assert.equal(timeout?.invalid, true);
    assert.equal(view.valid, false);
  });

  it("an unreadable boolean renders indeterminate (null), never a fabricated false", () => {
    const view = describeSettingsCard(
      { status: "ready", value: documentWith({ enabled: "yes" }), writable: true },
      new Map(),
    );
    assert.equal(view.fields[0]?.checked, null);
  });
});

describe("settings card — the save plan (ticket 47)", () => {
  it("plans one write per staged field, in schema order", () => {
    const plan = planSettingsCardWrites(
      new Map([
        ["wakeCoalesceWindowMs", "500"],
        ["enabled", "false"],
      ]),
    );
    assert.deepEqual(plan, {
      kind: "writes",
      writes: [
        { kind: "set", field: "enabled", value: false },
        { kind: "set", field: "wakeCoalesceWindowMs", value: 500 },
      ],
    });
  });

  it("an empty draft plans a clear — the field re-inherits the composition layer", () => {
    assert.deepEqual(planSettingsCardWrites(new Map([["enabled", ""]])), {
      kind: "writes",
      writes: [{ kind: "clear", field: "enabled" }],
    });
  });

  it("an unaccepted draft blocks the save instead of being dropped", () => {
    assert.deepEqual(planSettingsCardWrites(new Map([["wakeCoalesceWindowMs", "3ms"]])), {
      kind: "invalid",
      field: "wakeCoalesceWindowMs",
    });
    assert.deepEqual(planSettingsCardWrites(new Map([["enabled", "maybe"]])), {
      kind: "invalid",
      field: "enabled",
    });
  });

});

describe("settings card — store: staging, saving, and the honest failure path (ticket 47)", () => {
  /** A store already attached to a form that carries a served document. */
  function attached(options?: { noMutate?: boolean }) {
    const fake = createForm(options);
    fake.publish({ status: "ready", value: documentWith(), writable: true, revision: 7 });
    const store = createSettingsCardStore();
    store.attach(fake.form);
    return { fake, store };
  }

  it("binds the form immediately and reads a standing document at attach time", () => {
    const fake = createForm();
    fake.publish({ status: "ready", value: documentWith({ enabled: false }), writable: true });
    const store = createSettingsCardStore();
    // The page may hand over a form whose snapshot already stands at `ready`.
    assert.equal(store.getBox().view.available, false);
    store.attach(fake.form);
    assert.equal(store.getBox().view.available, true);
    assert.equal(store.getBox().view.fields[0]?.text, "false");
  });

  it("staging marks the form dirty and notifies; discard clears it", () => {
    const { store } = attached();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    assert.equal(store.getBox().dirty, false);
    store.edit("enabled", "false");
    assert.equal(store.getBox().dirty, true);
    assert.equal(store.getBox().view.fields[0]?.text, "false");
    assert.equal(notified, 1);
    store.discard();
    assert.equal(store.getBox().dirty, false);
    assert.equal(store.getBox().view.fields[0]?.text, "true");
    assert.equal(notified, 2);
  });

  it("save submits ONE atomic mutate with the read revision, then re-seeds and clears", async () => {
    const { fake, store } = attached();
    store.edit("enabled", "false");
    store.edit("wakeCoalesceWindowMs", "500");
    const pending = store.save();
    assert.equal(store.getBox().saving, true);
    // The Host applies the mutation and the mirror republishes; the store
    // reads THAT back rather than predicting it.
    fake.publish({
      status: "ready",
      value: documentWith({ enabled: false, wakeCoalesceWindowMs: 500 }),
      user: { enabled: false, wakeCoalesceWindowMs: 500 },
      writable: true,
    });
    fake.settle({
      status: "ready",
      value: documentWith({ enabled: false, wakeCoalesceWindowMs: 500 }),
      user: { enabled: false, wakeCoalesceWindowMs: 500 },
      writable: true,
    });
    await pending;
    assert.deepEqual(fake.writes, [
      {
        ops: [
          { op: "set", path: ["enabled"], value: false },
          { op: "set", path: ["wakeCoalesceWindowMs"], value: 500 },
        ],
        revision: 7,
      },
    ]);
    assert.equal(store.getBox().saving, false);
    assert.equal(store.getBox().failed, false);
    assert.equal(store.getBox().dirty, false);
    assert.deepEqual(
      store.getBox().view.fields.map((field) => field.text),
      // Ticket 113: the three inbox fields seed empty from the read-back.
      // Ticket 124: the microcompact switch, also empty.
      // Ticket 174 / ADR-0033 removed the access-timeout field.
      ["false", "500", "", "", "", ""],
    );
  });

  it("a staged clear saves as an unset op in the same mutation", async () => {
    const { fake, store } = attached();
    store.reset("enabled");
    await store.save();
    assert.deepEqual(fake.writes, [
      { ops: [{ op: "unset", path: ["enabled"] }], revision: 7 },
    ]);
  });

  it("an invalid draft refuses the save: no mutate call, drafts intact", async () => {
    const { fake, store } = attached();
    store.edit("wakeCoalesceWindowMs", "later");
    await store.save();
    assert.deepEqual(fake.writes, []);
    assert.equal(store.getBox().dirty, true);
    assert.equal(store.getBox().failed, false);
    assert.equal(store.getBox().saving, false);
  });

  it("a refused mutation (`false`) keeps the drafts and fails loudly", async () => {
    const { fake, store } = attached();
    store.edit("enabled", "false");
    fake.setRefuse(true);
    await store.save();
    // The form resolves `false` for a Host refusal or a skipped write; only
    // `true` means acceptance.
    assert.equal(store.getBox().failed, true);
    assert.equal(store.getBox().dirty, true);
    assert.equal(store.getBox().view.fields[0]?.text, "false");
  });

  it("a read-back that disagrees with the staged writes keeps the drafts and fails loudly", async () => {
    const { fake, store } = attached();
    store.edit("enabled", "false");
    fake.setDropWrites(true);
    const pending = store.save();
    // A fresh read-back is one at a CHANGED revision: the Host republishes
    // the document without applying the write (revision 7 -> 8) while the
    // save is in flight.
    fake.publish({
      status: "ready",
      value: documentWith(),
      writable: true,
      revision: 8,
    });
    await pending;
    // `mutate` can resolve `true` while the accepted document still disagrees,
    // so only the read-back can tell whether the value landed: claiming
    // success here would be a lie.
    assert.equal(store.getBox().failed, true);
    assert.equal(store.getBox().dirty, true);
    assert.equal(store.getBox().view.fields[0]?.text, "false");
  });

  it("an accepted write against a PLAIN-OBJECT form is never 'Not saved' (live defect)", async () => {
    // The shipped page hands `ConfigPageForm.state` as a plain object captured
    // at the last render, so immediately after `mutate` resolves it still
    // carries the PRE-SAVE document. Comparing the write against it reported a
    // successful save as failed; the form updates only when the page re-renders.
    const before = {
      status: "ready" as const,
      value: documentWith(),
      writable: true,
      revision: 2,
    };
    const form: ConfigPageFormLike = {
      state: before,
      mutate: async () => true,
    };
    const store = createSettingsCardStore();
    store.attach(form);
    store.edit("enabled", "false");
    await store.save();
    assert.equal(
      store.getBox().failed,
      false,
      "the host accepted; the pre-save snapshot is not a read-back",
    );
    assert.equal(store.getBox().dirty, false);

    // The page re-renders with the accepted document: a NEW plain object.
    store.attach({
      state: {
        status: "ready",
        value: documentWith({ enabled: false }),
        writable: true,
        revision: 3,
      },
      mutate: form.mutate,
    });
    assert.equal(store.getBox().failed, false);
    assert.equal(store.getBox().view.fields[0]?.text, "false");
  });

  it("defers the read-back to the refreshed plain-object snapshot and reports a dropped write there", async () => {
    const before = {
      status: "ready" as const,
      value: documentWith(),
      writable: true,
      revision: 2,
    };
    const mutate = async (): Promise<boolean> => true; // accepted, then dropped
    const form: ConfigPageFormLike = { state: before, mutate };
    const store = createSettingsCardStore();
    store.attach(form);
    store.edit("enabled", "false");
    await store.save();
    assert.equal(store.getBox().failed, false, "no verdict from a stale snapshot");

    // The page re-renders with a FRESH object that still carries the old
    // value: only now can the dropped write be reported, and the draft comes
    // back for correction.
    store.attach({
      state: {
        status: "ready",
        value: documentWith(),
        writable: true,
        revision: 3,
      },
      mutate,
    });
    assert.equal(store.getBox().failed, true);
    assert.equal(store.getBox().dirty, true);
    assert.equal(store.getBox().view.fields[0]?.text, "false");
  });

  it("uses a live getSnapshot reader to settle an accepted write immediately", async () => {
    // A form that can read the document now needs no deferred verification:
    // the live read either agrees (clean) or proves the write did not land —
    // but only once the Host revision actually advances.
    let state: ConfigFormSnapshotLike = {
      status: "ready",
      value: documentWith(),
      writable: true,
      revision: 4,
    };
    const form: ConfigPageFormLike = {
      get state() {
        return state;
      },
      getSnapshot: () => state,
      mutate: async () => {
        // The Host accepts and republishes at the next revision, still
        // carrying the old value (a dropped write).
        state = {
          status: "ready",
          value: documentWith(),
          writable: true,
          revision: 5,
        };
        return true;
      },
    };
    const store = createSettingsCardStore();
    store.attach(form);
    store.edit("enabled", "false");
    await store.save();
    assert.equal(store.getBox().failed, true, "the live read still shows enabled");
    assert.equal(store.getBox().dirty, true);
  });

  it("does not treat a republish at the same revision as a landed-write verdict", async () => {
    // The page can hand a NEW snapshot object without the Host revision
    // moving. That is the same document: it can neither prove the write
    // landed nor prove it was dropped.
    let state: ConfigFormSnapshotLike = {
      status: "ready",
      value: documentWith(),
      writable: true,
      revision: 5,
    };
    const form: ConfigPageFormLike = {
      get state() {
        return state;
      },
      // A new object each read, same revision: exactly the trap.
      getSnapshot: () => ({ ...state }),
      mutate: async () => true, // accepted, but the document does not change
    };
    const store = createSettingsCardStore();
    store.attach(form);
    store.edit("enabled", "false");
    await store.save();
    assert.equal(
      store.getBox().failed,
      false,
      "a same-revision republish is not a landed write",
    );
    assert.equal(store.getBox().dirty, false, "no verdict yet: drafts clear");
    assert.equal(store.getBox().saving, false);

    // The revision finally advances with the OLD value still there: now the
    // dropped write is reportable, and the parked draft returns.
    state = {
      status: "ready",
      value: documentWith(),
      writable: true,
      revision: 6,
    };
    store.attach({
      state,
      mutate: form.mutate,
    });
    assert.equal(store.getBox().failed, true);
    assert.equal(store.getBox().dirty, true);
    assert.equal(store.getBox().view.fields[0]?.text, "false");
  });

  it("a same-form page refresh during a save stays verifiable (not a rebind)", async () => {
    let state: ConfigFormSnapshotLike = {
      status: "ready",
      value: documentWith(),
      writable: true,
      revision: 7,
    };
    let finishMutate: ((accepted: boolean) => void) | undefined;
    const form: ConfigPageFormLike = {
      get state() {
        return state;
      },
      mutate: () =>
        new Promise<boolean>((resolve) => {
          finishMutate = resolve;
        }),
    };
    const store = createSettingsCardStore();
    store.attach(form);
    store.edit("enabled", "false");
    const pending = store.save();

    // The page refreshes with the same form object and the republished
    // document (the write was dropped): the save still owns its verification.
    state = {
      status: "ready",
      value: documentWith(),
      writable: true,
      revision: 8,
    };
    store.attach(form);
    finishMutate?.(true);
    await pending;

    assert.equal(store.getBox().failed, true);
    assert.equal(store.getBox().dirty, true);
  });

  it("a fresh-wrapper page refresh during a save keeps its outcome (shipped contract)", async () => {
    // The shipped page hands a NEW plain wrapper around the SAME cached entry
    // controller on every render (`dsh-client-ui-settings` client.js:1165-1170,
    // :1209-1231), so a refresh during an await replaces the wrapper object,
    // not the logical entry. Wrapper identity must not be read as a rebind.
    let state: ConfigFormSnapshotLike = {
      status: "ready",
      value: documentWith(),
      writable: true,
      revision: 7,
    };
    let finishMutate: ((accepted: boolean) => void) | undefined;
    const wrapper = (snapshot: ConfigFormSnapshotLike): ConfigPageFormLike => ({
      state: snapshot,
      mutate: () =>
        new Promise<boolean>((resolve) => {
          finishMutate = resolve;
        }),
    });
    const store = createSettingsCardStore();
    store.attach(wrapper(state));
    store.edit("enabled", "false");
    const pending = store.save();

    // The refresh's attach effect runs before the mutation settles: a new
    // wrapper carrying the republished document (the write was dropped).
    state = {
      status: "ready",
      value: documentWith(),
      writable: true,
      revision: 8,
    };
    store.attach(wrapper(state));
    finishMutate?.(true);
    await pending;

    // The outcome belongs to this save's logical entry: the dropped write
    // fails loudly, the submitted draft stays for correction, and Apply is
    // available again.
    assert.equal(store.getBox().failed, true);
    assert.equal(store.getBox().dirty, true);
    assert.equal(store.getBox().view.fields[0]?.text, "false");
    assert.equal(store.getBox().saving, false);
  });

  it("a save continuation from before detach never touches the reattached form", async () => {
    let finishMutate: ((accepted: boolean) => void) | undefined;
    const firstForm: ConfigPageFormLike = {
      state: { status: "ready", value: documentWith(), writable: true, revision: 1 },
      mutate: () =>
        new Promise<boolean>((resolve) => {
          finishMutate = resolve;
        }),
    };
    const store = createSettingsCardStore();
    store.attach(firstForm);
    store.edit("enabled", "false");
    const pending = store.save();
    assert.equal(store.getBox().saving, true);

    // The page unmounts mid-save and a NEW form is bound with its own draft.
    store.detach();
    const secondForm: ConfigPageFormLike = {
      state: { status: "ready", value: documentWith(), writable: true, revision: 2 },
      mutate: async () => true,
    };
    store.attach(secondForm);
    store.edit("wakeCoalesceWindowMs", "750");

    finishMutate?.(true);
    await pending;

    // The late continuation is stale: it must not clear the new draft, must
    // not resurrect a failure, and must not leave `saving` stuck.
    assert.equal(store.getBox().saving, false);
    assert.equal(store.getBox().failed, false);
    assert.equal(store.getBox().dirty, true);
    const timeout = store.getBox().view.fields.find(
      (field) => field.field === "wakeCoalesceWindowMs",
    );
    assert.equal(timeout?.text, "750");
  });

  it("attach(undefined) clears staged drafts and the failure line; the namespace returns clean", async () => {
    const { fake, store } = attached();
    store.edit("enabled", "false");
    fake.setRefuse(true);
    await store.save();
    assert.equal(store.getBox().failed, true);
    assert.equal(store.getBox().dirty, true);

    // The Host stops serving the namespace: nothing may survive it — a draft
    // keyed to a document that no longer exists would render as if accepted.
    store.attach(undefined);
    assert.equal(store.getBox().dirty, false);
    assert.equal(store.getBox().failed, false);
    assert.equal(store.getBox().view.available, false);

    fake.setRefuse(false);
    store.attach(fake.form);
    assert.equal(store.getBox().view.available, true);
    assert.equal(store.getBox().dirty, false);
    assert.equal(store.getBox().view.fields[0]?.text, "true");
  });

  it("isolates subscribers: a throwing one neither stops later ones nor escapes", () => {
    const { store } = attached();
    let later = 0;
    store.subscribe(() => {
      throw new Error("subscriber exploded");
    });
    store.subscribe(() => {
      later += 1;
    });
    assert.doesNotThrow(() => store.edit("enabled", "false"));
    assert.equal(later, 1, "the later subscriber still ran");
  });

  it("a malformed form.state is an unreadable document, never a thrown read", () => {
    const form = {
      get state(): ConfigFormSnapshotLike {
        throw new Error("state getter exploded");
      },
      mutate: async () => true,
    } as ConfigPageFormLike;
    const store = createSettingsCardStore();
    assert.doesNotThrow(() => store.attach(form));
    assert.equal(store.getBox().view.available, false);
    assert.doesNotThrow(() => store.edit("enabled", "false"));
  });

  it("a throwing mutate fails loudly and keeps the drafts for correction", async () => {
    const { fake, store } = attached();
    fake.setThrowOnWrite(true);
    store.edit("enabled", "false");
    await store.save();
    assert.equal(store.getBox().failed, true);
    assert.equal(store.getBox().dirty, true);
  });

  it("a form with no write verb is read-only, and saves nothing", async () => {
    const { fake, store } = attached({ noMutate: true });
    assert.equal(store.getBox().view.writable, false);
    store.edit("enabled", "false");
    await store.save();
    assert.deepEqual(fake.writes, []);
    assert.equal(store.getBox().dirty, true);
  });

  it("an unavailable form drops the card; detach forgets the drafts", () => {
    const { fake, store } = attached();
    store.edit("enabled", "false");
    fake.publish({ status: "unavailable", writable: false });
    // The store only re-reads on attach; the component re-attaches on a new
    // snapshot. A re-attach of the same form is the page's refresh path.
    store.attach(fake.form);
    assert.equal(store.getBox().view.available, false);
    store.detach();
    assert.equal(store.getBox().view.available, false);
    assert.equal(store.getBox().dirty, false);
  });

  it("no form: the card reports unavailable and renders nothing", () => {
    const store = createSettingsCardStore();
    store.attachUnavailable();
    assert.equal(store.getBox().view.available, false);
    assert.deepEqual(store.getBox().view.fields, []);
  });
});

describe("settings card — apply() wiring over the fake client seams (ticket 47)", () => {
  it("no form ever handed in: the card stays unavailable, never a fake degrade", () => {
    const ctx = createClientCtx();
    const card = createSettingsCardStore();
    assert.doesNotThrow(() => applyClientModule(ctx, createRosterStore(), card));
    assert.equal(card.getBox().view.available, false);
    assert.equal(cardInject(ctx)?.entries.length, 1, "the entry still registers");
  });

});
