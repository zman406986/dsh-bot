/**
 * The plugin's configuration row: registration data + the form model behind
 * it (ticket 47).
 *
 * dsh 0.2.1 renders a plugin row's configuration from the keyed
 * `plugins.row.config` slot: the Plugins page keys the cell
 * `<package name>#<row id>` (`dsh-client-ui-plugin-manager`
 * `lib/client.js:27-29`) and passes the entry's accepted snapshot and its
 * one atomic write verb as owner props (`slot-contract.d.ts:165-169`,
 * `:202-208`). The row id, the Loader entry id, and the Host settings
 * namespace must be the same string, or the page renders no configure control.
 *
 * So the entry's `key` is `<package name>#<settings namespace>` and it edits
 * the form the page hands it — never a client service of its own.
 *
 * Honesty rules this model encodes:
 * - no form, or an `unavailable` snapshot, yields `available: false` — the
 *   card renders NOTHING, the opposite of a disabled card a user cannot act
 *   on;
 * - the rendered text is the draft, so what is on screen is exactly what a save
 *   would write;
 * - `overridden` is PRESENCE in the raw user layer, not a value comparison —
 *   an override equal to the composition default is still an override, so an
 *   empty draft means "clear" and lets the field re-inherit the composition
 *   layer;
 * - a draft the field does not accept BLOCKS the save instead of being dropped;
 * - a save is ONE `mutate(ops, revision)` call; a `false` answer or a
 *   read-back that disagrees with what was staged keeps the drafts and says so,
 *   rather than reporting a success the document does not carry.
 *
 * Pure registration data + pure model: no React, no DOM, no Cordis (tests
 * assert this module directly, offline, S8). The component factory that
 * consumes these view models lives in `settings-card.tsx`.
 */

import { CLIENT_MODULE_ID } from "./wrapper.js";
import type {
  ConfigFormSnapshotLike,
  ConfigPageFormLike,
  SettingsPathOpLike,
} from "./context.js";
import { LOCALE_NAMESPACE } from "./overlay.js";

/**
 * The shipped keyed slot for one plugin row's configuration page. dsh-owned;
 * never an invented slot name. The Plugins page declares it while its `main`
 * entry is mounted (`dsh-client-ui-plugin-manager/lib/client.js:4440-4444`).
 */
export const PLUGINS_ROW_CONFIG_SLOT = "plugins.row.config";

/**
 * Registration options for the keyed card entry. Keyed entries carry `key`
 * instead of the list entries' `id`/`order`.
 */
export interface SettingsCardRegistrationOptions {
  /** The shipped slot key this entry renders into. */
  readonly name: string;
  /** The keyed cell: `<package name>#<row id>`, both as the Host serves them. */
  readonly key: string;
  /** Locale namespace declared on the entry so the kit's `t` seat binds. */
  readonly locale: string;
}

/**
 * Build the card's `plugins.row.config` registration options. The package
 * name is the scanned module id; the row id is the plugin's settings
 * namespace, which the profile patch, the Loader entry, and the Host form all
 * share.
 */
export function settingsCardRegistration(): SettingsCardRegistrationOptions {
  return {
    name: PLUGINS_ROW_CONFIG_SLOT,
    key: `${CLIENT_MODULE_ID}#${LOCALE_NAMESPACE}`,
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
 * `wakeCoalesceWindowMs`, `inboxEnabled`, `racoonsRecordOnly`,
 * `racoonsStorageRoot`, `racoonsContextWindowTokens`, `inboxDir`,
 * `inboxRescanIntervalMs`, `microcompactEnabled`), in schema order. The pair
 * is pinned offline against `Config.dict`, so a field added to the schema
 * without a control fails the suite instead of silently rendering an editable
 * card that hides part of the namespace.
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
    "racoonsRecordOnly",
    "settings.card.field.racoonsRecordOnly.label",
    "settings.card.field.racoonsRecordOnly.hint",
  ),
  stringFieldSpec(
    "racoonsStorageRoot",
    "settings.card.field.racoonsStorageRoot.label",
    "settings.card.field.racoonsStorageRoot.hint",
  ),
  numberFieldSpec(
    "racoonsContextWindowTokens",
    "settings.card.field.racoonsContextWindowTokens.label",
    "settings.card.field.racoonsContextWindowTokens.hint",
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
  booleanFieldSpec(
    "microcompactEnabled",
    "settings.card.field.microcompactEnabled.label",
    "settings.card.field.microcompactEnabled.hint",
  ),
];

/**
 * The form-side input the model reads. Structural, and every descriptive
 * field is optional so a minimal form still works: an absent `writable` is
 * treated as not writable — never as permission.
 * Mirrors `ConfigFormSnapshotLike` in `context.ts`.
 */
export interface SettingsCardSnapshotInput {
  /** `loading` until the first accepted section; `unavailable` when the entry is not served. */
  readonly status: "loading" | "ready" | "unavailable";
  /** Last accepted schema-resolved section; undefined before the first acceptance. */
  readonly value?: unknown;
  /** Composition layer the Host resolved `value` over — what a cleared field reverts to. */
  readonly base?: unknown;
  /** Raw user layer as stored; a field's PRESENCE here marks it overridden. */
  readonly user?: unknown;
  /** Whether the Host document accepts writes. */
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
 * The card's data path (ticket 47): one slot-supplied form in, one render
 * model out, plus the staging/save actions the component calls. The form is
 * the page's own (`plugins.row.config` owner props); the card never reaches
 * for a service of its own.
 */
export interface SettingsCardStore {
  /** Stable getter for `useSyncExternalStore`. */
  getBox(): SettingsCardBox;
  /** Subscribe to box replacements; returns the unsubscribe disposer. */
  subscribe(listener: () => void): () => void;
  /**
   * Bind the form handed in by the slot owner. The snapshot is read at once:
   * a page opened after the first accepted section already stands at `ready`.
   */
  attach(form: ConfigPageFormLike | undefined): void;
  /** No form was handed in: no card, no error surface. */
  attachUnavailable(): void;
  /** Stop reading and forget the staged drafts. */
  detach(): void;
  /** Stage draft text for one field (no wire write). */
  edit(field: string, text: string): void;
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  reset(field: string): void;
  /** Drop every staged draft. */
  discard(): void;
  /**
   * Submit every staged draft as ONE atomic `mutate(ops, revision)`, then
   * re-seed from what the form reads back.
   */
  save(): Promise<void>;
}

const IDLE_VIEW: SettingsCardView = UNAVAILABLE_VIEW;

/** The card's own store: drafts + the handed-in form, projected into one box. */
export function createSettingsCardStore(): SettingsCardStore {
  let form: ConfigPageFormLike | null = null;
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
    if (form === null) return;
    const next = describeSettingsCard(form.state, staged);
    // A form without a write verb cannot be written to even when the document
    // claims to accept writes: the capability, not the claim, is what counts.
    view =
      next.available && typeof form.mutate !== "function"
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
    attach(next: ConfigPageFormLike | undefined) {
      form = next ?? null;
      if (form === null) {
        view = UNAVAILABLE_VIEW;
        publish();
        return;
      }
      read();
    },
    attachUnavailable() {
      form = null;
      view = UNAVAILABLE_VIEW;
      publish();
    },
    detach() {
      form = null;
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
      const bound = form;
      if (saving || bound === null || !view.writable) return Promise.resolve();
      const plan = planSettingsCardWrites(staged);
      // An unaccepted draft blocks the save: the form stays dirty and the
      // invalid control carries the reason, so nothing is dropped silently.
      if (plan.kind === "invalid") return Promise.resolve();
      if (plan.writes.length === 0) return Promise.resolve();
      const writes = plan.writes;
      const revision = bound.state.revision;
      const ops: SettingsPathOpLike[] = writes.map((write) =>
        write.kind === "set"
          ? { op: "set", path: [write.field], value: write.value }
          : { op: "unset", path: [write.field] },
      );

      saving = true;
      failed = false;
      publish();
      return (async () => {
        try {
          // One atomic mutation: every staged field shares one revision fence
          // and one Host validation, so a partial document cannot land.
          const accepted = await bound.mutate(ops, revision);
          if (!accepted) {
            failed = true;
            return;
          }
          // The Host is the only authority on whether a value was accepted,
          // so the outcome is read back rather than assumed. A read-back that
          // disagrees with what was staged keeps the drafts and reports the
          // failure instead of claiming a success the document does not carry.
          const landed = form === null ? null : form.state;
          const section = asRecord(landed?.value);
          const mismatch = writes.some((write) => {
            if (write.kind === "set") {
              return section === null
                ? false
                : section[write.field] !== write.value;
            }
            return carries(landed?.user, write.field);
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
