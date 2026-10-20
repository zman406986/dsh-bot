/**
 * The `settings.plugin.item` card: registration data + the form model behind
 * it (ticket 47).
 *
 * The Plugins settings section's 插件配置 tab renders the INTERSECTION of two
 * ledgers — the settings namespaces the Host serves and the cards registered
 * into the keyed `settings.plugin.item` slot, dispatched as
 * `renderSlot("settings.plugin.item", {}, { entryKey: ns })` per served
 * namespace (`dsh-client-ui-settings-plugins/lib/client.js:402-416`). The Host
 * already serves our namespace, so before this module existed the section could
 * not appear at all: a served namespace no card claims renders nothing.
 *
 * Keying on the settings namespace is the whole pairing contract
 * (`…/lib/types/client/slot-contract.d.ts:16-25`): the tab pairs a Host
 * namespace with a browser card by slot key and never learns what the
 * namespace means. So the entry's `key` is the plugin's settings namespace —
 * the SAME string the host half installs (`src/adapter/settings-section.ts`
 * `SETTINGS_NAMESPACE`) and the same one the locale namespace uses.
 *
 * Reads and writes ride the SAME `ctx.settingsScope` bind the roster watch
 * uses (ticket 46's corrected contract — `bind({namespace})` →
 * `getSnapshot()`/`subscribe()`/`set()`/`unset()`; see `context.ts`). Never a
 * second channel and never a direct `remote.settings` call from a new seam.
 *
 * Honesty rules this model encodes:
 * - a namespace the scope reports `unavailable` (or that has accepted no
 *   document yet) yields `available: false` — the card renders NOTHING, which
 *   is the shipped idiom (`PluginCard` returns null while unavailable) and the
 *   opposite of a disabled card a user cannot act on;
 * - the rendered text is the draft, so what is on screen is exactly what a save
 *   would write;
 * - `overridden` is PRESENCE in the raw user layer, not a value comparison —
 *   an override equal to the composition default is still an override
 *   (`settings-contract.d.ts:20-25`), so an empty draft means "clear" and lets
 *   the field re-inherit the composition layer;
 * - a draft the field does not accept BLOCKS the save instead of being dropped;
 * - a save whose read-back disagrees with what was staged keeps the drafts and
 *   says so, rather than reporting a success the document does not carry.
 *
 * Pure registration data + pure model: no React, no DOM, no Cordis (tests
 * assert this module directly, offline, S8). The component factory that
 * consumes these view models lives in `settings-card.tsx`.
 */

import type { ClientSettingsScopeLike } from "./context.js";
import { LOCALE_NAMESPACE } from "./overlay.js";

/**
 * The shipped keyed slot for one plugin's card inside the configurable-plugins
 * tab. dsh-owned; never an invented slot name (design-16 §5 rule). The tab
 * declares it at runtime (`dsh-client-ui-settings-plugins/lib/client.js:1773-1784`).
 */
export const SETTINGS_PLUGIN_ITEM_SLOT = "settings.plugin.item";

/**
 * Registration options for the keyed card entry. Keyed entries carry `key` (the
 * settings namespace the card edits) instead of the list entries' `id`/`order`
 * — the tab orders cards by registration order, not by a sort key
 * (`…/types/client/tab-store.d.ts:16-25`).
 */
export interface SettingsCardRegistrationOptions {
  /** The shipped slot key this entry renders into. */
  readonly name: string;
  /** The keyed cell: our settings namespace, exactly as the Host serves it. */
  readonly key: string;
  /** Locale namespace declared on the entry so the kit's `t` seat binds. */
  readonly locale: string;
}

/**
 * Build the card's `settings.plugin.item` registration options: `key` is the
 * plugin's own namespace (`multitask-dispatcher`), which is what pairs the card
 * with the Host-served namespace; `locale` is the same string so our dictionary
 * seats the card's copy.
 */
export function settingsCardRegistration(): SettingsCardRegistrationOptions {
  return {
    name: SETTINGS_PLUGIN_ITEM_SLOT,
    key: LOCALE_NAMESPACE,
    locale: LOCALE_NAMESPACE,
  };
}

/** Card chrome copy keys. */
export const SETTINGS_CARD_TITLE_KEY = "settings.card.title";
export const SETTINGS_CARD_DESCRIPTION_KEY = "settings.card.description";
export const SETTINGS_CARD_EXPAND_KEY = "settings.card.expand";
export const SETTINGS_CARD_COLLAPSE_KEY = "settings.card.collapse";
export const SETTINGS_CARD_UNSAVED_KEY = "settings.card.unsaved";
export const SETTINGS_CARD_READONLY_KEY = "settings.card.readonly";
export const SETTINGS_CARD_SAVE_KEY = "settings.card.save";
export const SETTINGS_CARD_DISCARD_KEY = "settings.card.discard";
export const SETTINGS_CARD_FAILED_KEY = "settings.card.failed";

/** Per-field control copy keys (shared by both field kinds). */
export const SETTINGS_CARD_OVERRIDDEN_KEY = "settings.card.overridden";
export const SETTINGS_CARD_RESET_KEY = "settings.card.reset";
export const SETTINGS_CARD_INVALID_KEY = "settings.card.invalid";

/** One write a staged draft plans. An empty draft stages a clear. */
export type SettingsCardWrite =
  | { readonly kind: "set"; readonly field: string; readonly value: unknown }
  | { readonly kind: "clear"; readonly field: string };

/**
 * How one schema field converts between its stored value and its draft text.
 * `format` renders the effective value (user layer over composition layer over
 * schema default) and the empty string when there is none; `parse` returns the
 * write the draft stages, or undefined when the field does not accept it.
 */
export interface SettingsCardFieldSpec {
  /** Field name inside the namespace section. */
  readonly field: string;
  /** Which control the card renders for this field. */
  readonly kind: "boolean" | "number" | "string";
  /** Locale key of the visible label. */
  readonly labelKey: string;
  /** Locale key of the one-line explanation under the control. */
  readonly hintKey: string;
  /** Render a stored value as draft text; "" when the section carries none. */
  format(value: unknown): string;
  /** The write this draft stages, or undefined when it is not accepted. */
  parse(text: string): SettingsCardWrite | undefined;
}

/** Stored boolean → draft text. Anything unreadable renders as an empty draft. */
function formatBoolean(value: unknown): string {
  return typeof value === "boolean" ? (value ? "true" : "false") : "";
}

/**
 * Draft text → boolean write. The empty draft clears the field (it re-inherits
 * the composition layer) — the same convention the shipped card form uses for
 * every non-credential field (`card-form.d.ts` `numberField`/`textField`).
 */
function parseBoolean(field: string, text: string): SettingsCardWrite | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "clear", field };
  if (trimmed === "true") return { kind: "set", field, value: true };
  if (trimmed === "false") return { kind: "set", field, value: false };
  return undefined;
}

/** Stored number → draft text (only a finite number renders a draft). */
function formatNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/**
 * Draft text → number write. Empty means clear; anything that is not a finite
 * number blocks the save rather than being silently dropped or coerced.
 */
function parseNumber(field: string, text: string): SettingsCardWrite | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "clear", field };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return undefined;
  return { kind: "set", field, value };
}

/** Stored string → draft text, verbatim. Anything unreadable renders empty. */
function formatString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Draft text → string write (ticket 113 `inboxDir`). Empty means clear; the
 * trimmed text stages verbatim otherwise — every non-empty string is a
 * string, so nothing but emptiness blocks the save.
 */
function parseString(field: string, text: string): SettingsCardWrite | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "clear", field };
  return { kind: "set", field, value: trimmed };
}

/** One draft-text field spec of the given kind, bound to its own field name. */
function booleanFieldSpec(
  field: string,
  labelKey: string,
  hintKey: string,
): SettingsCardFieldSpec {
  return {
    field,
    kind: "boolean",
    labelKey,
    hintKey,
    format: formatBoolean,
    parse: (text) => parseBoolean(field, text),
  };
}

/** One number field spec, bound to its own field name. */
function numberFieldSpec(
  field: string,
  labelKey: string,
  hintKey: string,
): SettingsCardFieldSpec {
  return {
    field,
    kind: "number",
    labelKey,
    hintKey,
    format: formatNumber,
    parse: (text) => parseNumber(field, text),
  };
}

/** One string field spec (ticket 113), bound to its own field name. */
function stringFieldSpec(
  field: string,
  labelKey: string,
  hintKey: string,
): SettingsCardFieldSpec {
  return {
    field,
    kind: "string",
    labelKey,
    hintKey,
    format: formatString,
    parse: (text) => parseString(field, text),
  };
}

/**
 * The schema fields this card edits — EXACTLY the fields of the host half's
 * `Config` (`src/plugin.ts`: `enabled`, `accessRequestTimeoutMs`,
 * `wakeCoalesceWindowMs`, `inboxEnabled`, `racoonsEnabled`, `inboxDir`,
 * `inboxRescanIntervalMs`), in schema order. The pair is pinned offline against
 * `Config.dict`, so a field added to the schema without a control fails the
 * suite instead of silently rendering an editable card that hides part of the
 * namespace.
 *
 * The `enabled` hint phrases the flag as the SETTING (ADR-0005): a saved change
 * lands in NEW chats, never as a live toggle of the running session.
 */
export const SETTINGS_CARD_FIELDS: readonly SettingsCardFieldSpec[] = [
  booleanFieldSpec(
    "enabled",
    "settings.card.field.enabled.label",
    "settings.card.field.enabled.hint",
  ),
  numberFieldSpec(
    "accessRequestTimeoutMs",
    "settings.card.field.accessRequestTimeoutMs.label",
    "settings.card.field.accessRequestTimeoutMs.hint",
  ),
  numberFieldSpec(
    "wakeCoalesceWindowMs",
    "settings.card.field.wakeCoalesceWindowMs.label",
    "settings.card.field.wakeCoalesceWindowMs.hint",
  ),
  booleanFieldSpec(
    "inboxEnabled",
    "settings.card.field.inboxEnabled.label",
    "settings.card.field.inboxEnabled.hint",
  ),
  booleanFieldSpec(
    "racoonsEnabled",
    "settings.card.field.racoonsEnabled.label",
    "settings.card.field.racoonsEnabled.hint",
  ),
  stringFieldSpec(
    "inboxDir",
    "settings.card.field.inboxDir.label",
    "settings.card.field.inboxDir.hint",
  ),
  numberFieldSpec(
    "inboxRescanIntervalMs",
    "settings.card.field.inboxRescanIntervalMs.label",
    "settings.card.field.inboxRescanIntervalMs.hint",
  ),
];

/**
 * The scope-side input the model reads. Structural, and every descriptive
 * field is optional so a minimal scope (or a pre-ticket-47 fake) still works:
 * an absent `writable` is treated as not writable — never as permission.
 * Mirrors `ClientSettingsScopeSnapshotLike` in `context.ts`.
 */
export interface SettingsCardSnapshotInput {
  /** `loading` until the first accepted section; `unavailable` when the namespace is not served. */
  readonly status: "loading" | "ready" | "unavailable";
  /** Last accepted schema-resolved section; undefined before the first acceptance. */
  readonly value?: unknown;
  /** Composition layer the Host resolved `value` over — what a cleared field reverts to. */
  readonly base?: unknown;
  /** Raw user layer as stored; a field's PRESENCE here marks it overridden. */
  readonly user?: unknown;
  /** Whether the Host document accepts writes (memory mode never does). */
  readonly writable?: boolean;
}

/** One field as the card's control renders it. */
export interface SettingsCardFieldBox {
  readonly field: string;
  readonly kind: "boolean" | "number" | "string";
  readonly labelKey: string;
  readonly hintKey: string;
  /** Draft text the control renders. */
  readonly text: string;
  /**
   * Checkbox state for a `boolean` field: what a save would leave there, or the
   * composition default after a staged clear. Null when nothing readable backs
   * either — the control renders indeterminate rather than asserting `false`.
   */
  readonly checked: boolean | null;
  /** Whether the raw user layer carries this field (presence, not comparison). */
  readonly overridden: boolean;
  /** Whether the draft is not a value this field accepts, which blocks the save. */
  readonly invalid: boolean;
}

/** The card's whole render model. */
export interface SettingsCardView {
  /** False while the namespace is not served or has accepted no section: render nothing. */
  readonly available: boolean;
  /** Whether the Host document accepts writes (memory mode never does). */
  readonly writable: boolean;
  /** Whether every draft is a value its field accepts. */
  readonly valid: boolean;
  readonly fields: readonly SettingsCardFieldBox[];
}

/** Empty view for the states that render nothing. */
const UNAVAILABLE_VIEW: SettingsCardView = {
  available: false,
  writable: false,
  valid: true,
  fields: [],
};

/** Narrow to a plain object record (arrays are not records here). */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Whether the raw user layer carries a field (PRESENCE is the override marker). */
function carries(resource: unknown, field: string): boolean {
  const record = asRecord(resource);
  return record !== null && Object.prototype.hasOwnProperty.call(record, field);
}

/**
 * Build the card's render model from one scope snapshot and the staged drafts.
 *
 * `available: false` (render nothing) covers `unavailable` — the namespace is
 * not exposed to this client, so there is nothing honest to edit — and a
 * `value` that is absent or not an object, i.e. a section the Host has not
 * accepted yet or one that does not carry our schema's shape. `writable`
 * requires the snapshot to say so; an absent flag is not permission.
 */
export function describeSettingsCard(
  snapshot: SettingsCardSnapshotInput,
  staged: ReadonlyMap<string, string>,
): SettingsCardView {
  if (snapshot.status === "unavailable") return UNAVAILABLE_VIEW;
  const section = asRecord(snapshot.value);
  if (section === null) return UNAVAILABLE_VIEW;

  const fields: SettingsCardFieldBox[] = [];
  let valid = true;
  for (const spec of SETTINGS_CARD_FIELDS) {
    const draft = staged.get(spec.field);
    const effective = section[spec.field];
    const text = draft !== undefined ? draft : spec.format(effective);
    const write = spec.parse(text);
    if (write === undefined) valid = false;

    // What the control would show after a save: the staged write's value, the
    // composition default for a staged clear, the effective value when nothing
    // is staged. Null when none of those is a boolean — never a guessed `false`.
    let preview: unknown;
    if (draft === undefined) {
      preview = effective;
    } else if (write === undefined) {
      preview = undefined;
    } else {
      preview =
        write.kind === "set" ? write.value : asRecord(snapshot.base)?.[spec.field];
    }

    fields.push({
      field: spec.field,
      kind: spec.kind,
      labelKey: spec.labelKey,
      hintKey: spec.hintKey,
      text,
      checked: typeof preview === "boolean" ? preview : null,
      overridden: carries(snapshot.user, spec.field),
      invalid: write === undefined,
    });
  }

  return {
    available: true,
    writable: snapshot.writable === true,
    valid,
    fields,
  };
}

/** What one save would write. */
export type SettingsCardPlan =
  | { readonly kind: "invalid"; readonly field: string }
  | { readonly kind: "writes"; readonly writes: readonly SettingsCardWrite[] };

/**
 * Plan the writes the staged drafts would perform, in field order. An
 * unaccepted draft yields the `invalid` plan — the save refuses rather than
 * dropping the edit. A staged field whose draft is empty plans a clear.
 */
export function planSettingsCardWrites(
  staged: ReadonlyMap<string, string>,
): SettingsCardPlan {
  const writes: SettingsCardWrite[] = [];
  for (const spec of SETTINGS_CARD_FIELDS) {
    const draft = staged.get(spec.field);
    if (draft === undefined) continue;
    const write = spec.parse(draft);
    if (write === undefined) return { kind: "invalid", field: spec.field };
    writes.push(write);
  }
  return { kind: "writes", writes };
}

/** Box handed to React's `useSyncExternalStore`. */
export interface SettingsCardBox {
  readonly view: SettingsCardView;
  /** Whether the form holds edits a save would write. */
  readonly dirty: boolean;
  /** Whether a save is crossing the wire. */
  readonly saving: boolean;
  /** Whether the last save did not land as staged; cleared by the next edit or save. */
  readonly failed: boolean;
  readonly version: number;
}

/**
 * The card's data path (ticket 47): one bound scope in, one render model out,
 * plus the staging/save actions the component calls. Never reads a second
 * channel — `attach` is handed the SAME scope the roster watch binds.
 */
export interface SettingsCardStore {
  /** Stable getter for `useSyncExternalStore`. */
  getBox(): SettingsCardBox;
  /** Subscribe to box replacements; returns the unsubscribe disposer. */
  subscribe(listener: () => void): () => void;
  /**
   * Bind the live namespace scope and start reading it (immediately, not only
   * on the next replacement — a scope bound after the first accepted section
   * already stands at `ready`).
   */
  attach(scope: ClientSettingsScopeLike): void;
  /** The service or namespace is missing: no card, no error surface. */
  attachUnavailable(): void;
  /** Stop reading and forget the staged drafts. */
  detach(): void;
  /** Stage draft text for one field (no wire write). */
  edit(field: string, text: string): void;
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  reset(field: string): void;
  /** Drop every staged draft. */
  discard(): void;
  /** Write every staged draft through the scope, then re-seed from what it reads back. */
  save(): Promise<void>;
}

const IDLE_VIEW: SettingsCardView = UNAVAILABLE_VIEW;

/** The card's own store: drafts + the bound scope, projected into one box. */
export function createSettingsCardStore(): SettingsCardStore {
  let scope: ClientSettingsScopeLike | null = null;
  let disposeScope: (() => void) | undefined;
  const staged = new Map<string, string>();
  let view: SettingsCardView = IDLE_VIEW;
  let saving = false;
  let failed = false;
  let version = 0;
  let box: SettingsCardBox = {
    view,
    dirty: staged.size > 0,
    saving,
    failed,
    version,
  };
  const listeners = new Set<() => void>();

  function publish(): void {
    version += 1;
    box = { view, dirty: staged.size > 0, saving, failed, version };
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function read(): void {
    if (scope === null) return;
    const snapshot = scope.getSnapshot();
    const next = describeSettingsCard(snapshot, staged);
    // A scope with no write path cannot be written to even when the document
    // claims to accept writes: the capability, not the claim, is what counts.
    view =
      next.available && typeof scope.set !== "function"
        ? { ...next, writable: false }
        : next;
    publish();
  }

  return {
    getBox() {
      return box;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attach(next: ClientSettingsScopeLike) {
      if (scope !== null) {
        disposeScope?.();
        disposeScope = undefined;
      }
      scope = next;
      disposeScope = next.subscribe(read);
      read();
    },
    attachUnavailable() {
      scope = null;
      disposeScope = undefined;
      view = UNAVAILABLE_VIEW;
      publish();
    },
    detach() {
      disposeScope?.();
      disposeScope = undefined;
      scope = null;
      staged.clear();
      saving = false;
      failed = false;
      view = UNAVAILABLE_VIEW;
      publish();
    },
    edit(field: string, text: string) {
      staged.set(field, text);
      failed = false;
      read();
    },
    reset(field: string) {
      staged.set(field, "");
      failed = false;
      read();
    },
    discard() {
      staged.clear();
      failed = false;
      read();
    },
    save(): Promise<void> {
      const bound = scope;
      if (saving || bound === null || !view.writable) return Promise.resolve();
      const plan = planSettingsCardWrites(staged);
      // An unaccepted draft blocks the save: the form stays dirty and the
      // invalid control carries the reason, so nothing is dropped silently.
      if (plan.kind === "invalid") return Promise.resolve();
      if (plan.writes.length === 0) return Promise.resolve();
      const writes = plan.writes;

      saving = true;
      failed = false;
      publish();
      return (async () => {
        try {
          for (const write of writes) {
            if (write.kind === "set") {
              await bound.set?.(write.field, write.value);
            } else {
              await bound.unset?.(write.field);
            }
          }
          // The Host is the only authority on whether a value was accepted, and
          // a scope write resolves either way — so the outcome is read back
          // rather than assumed. A read-back that disagrees with what was
          // staged keeps the drafts and reports the failure instead of claiming
          // a success the document does not carry.
          const landed = bound.getSnapshot();
          const section = asRecord(landed.value);
          const mismatch = writes.some((write) => {
            if (write.kind === "set") {
              return section === null
                ? false
                : section[write.field] !== write.value;
            }
            return carries(landed.user, write.field);
          });
          if (mismatch) {
            failed = true;
          } else {
            staged.clear();
          }
        } catch {
          failed = true;
        } finally {
          saving = false;
          read();
        }
      })();
    },
  };
}
