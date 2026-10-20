/**
 * Structural client-face context (ticket 20).
 *
 * Structural typing only — no import from `@deepseek-ai/dsh-client-ui-renderer`
 * or `@deepseek-ai/dsh-client-locale` (peer surfaces, not dependencies).
 * Shapes mirror the verified seams in `docs/research/dsh-plugin-ui-patterns.md`:
 *
 * - `ctx.slots.inject(parent, cb)` waits for the parent slot declaration and
 *   installs its registration effect on the CALLER's fiber (Finding 5);
 * - `ctx.slots.register(options, component)` returns the disposer and is
 *   fiber-scoped (Finding 5, `registry.d.ts:77-83`);
 * - `ctx.locale.register(ns, {zh, en})` registers copy dictionaries and
 *   `ctx.locale.bind(ns)` returns the `t` seat for a namespace (Finding 6);
 * - `ctx.effect(execute, label?)` runs `execute` immediately and collects the
 *   returned function as the unload disposer (vendored cordis `effect`);
 * - one plugin entry's configuration comes from the `plugins.row.config` slot
 *   owner props: `form.state` is the accepted snapshot and
 *   `form.mutate(ops, revision)` is the one atomic write path
 *   (`dsh-client-ui-plugin-manager` `slot-contract.d.ts:202-208`). The
 *   settings card reads and writes through that handed-in form only.
 */

import type { LocaleDictionary, SlotRegistrationOptions } from "./overlay.js";
import type { ToolviewRegistrationOptions } from "./toolviews.js";
import type { SettingsCardRegistrationOptions } from "./settings-card-store.js";
import type { ConversationSourceLike } from "./conversation-store.js";

/** Any slot entry this module registers: list entries (id/order), keyed
 * entries such as the `tool.call.toolview` toolviews (key) and the
 * `plugins.row.config` settings card (key), keyed `main` pages (key), and
 * single-slot entries such as the cutover's `root` frame (no id/key — the
 * single cell elects one occupant; the entry carries an EXPLICIT shadowing
 * priority — ticket 85: an absent priority defaults to 0, collides with the
 * shipped frame, and the host register THROWS). */
export type SlotEntryOptions =
  | SlotRegistrationOptions
  | ToolviewRegistrationOptions
  | SettingsCardRegistrationOptions
  | SingleSlotRegistrationOptions;

/**
 * One SINGLE-slot entry's registration options (the ticket-78 cutover's
 * `root` frame; built by `shellRootRegistration` in `shell-mount.ts`, which
 * owns the contract and its citations). No `id` and no `key`: a single slot
 * has one elected occupant, and the runtime catalog's own `root` example
 * passes only `{name}` (dsh-cordis-client-runner lib/client.js:3514-3520).
 * `priority` is REQUIRED (ticket 85, 2026-09-19): the shipped single-slot
 * register defaults an absent priority to 0 — the shipped AppFrame's own
 * effective value — and throws on that collision instead of shadowing; the
 * entry must carry the explicit lower value.
 * Declared here structurally — this module is the context's type seat and
 * `shell-mount.ts` already imports from it.
 */
export interface SingleSlotRegistrationOptions {
  /** The dsh-owned single slot key (e.g. `root`). */
  readonly name: string;
  /** Locale namespace declared on the entry so the kit's `t` seat binds. */
  readonly locale: string;
  /**
   * The explicit shadowing priority (ticket 85): lower value renders first
   * ("lowest renders"); `-1` shadows the shipped frame's effective 0.
   */
  readonly priority: number;
}

/** `ctx.slots` surface used by this scaffold. */
export interface SlotsServiceLike {
  /**
   * Install `callback` once `<parent>`'s slot declaration exists; collapse of
   * the declaration disposes the effect. Registrations made inside the
   * callback land on this module's fiber and reverse with it.
   */
  inject(parent: string, callback: () => unknown): unknown;
  /** Register a component into a slot; returns the exact disposer. */
  register(options: SlotEntryOptions, component: unknown): unknown;
}

/** `ctx.locale` surface used by this scaffold. */
export interface LocaleServiceLike {
  /** Register an `{en, zh}` copy dictionary under a plugin-owned namespace. */
  register(namespace: string, dictionary: LocaleDictionary): unknown;
  /** Bind the `t` seat for a namespace. */
  bind(namespace: string): (key: string) => string;
}

/**
 * One plugin entry's accepted configuration snapshot, as the
 * `plugins.row.config` slot owner supplies it
 * (`ConfigFormSnapshot<T>`, `dsh-client-ui-settings`
 * `lib/types/client/config-form-types.d.ts:6-29`).
 *
 * The status carries the read state, `revision` fences the next write, and a
 * field's PRESENCE in `user` is what marks it overridden — an override equal
 * to the composition default is still an override, and comparing values could
 * not see it (`:19-24`).
 */
export interface ConfigFormSnapshotLike {
  /** `loading` until the first accepted section, `ready` while one stands, and `unavailable` when the entry is not served. */
  readonly status: "loading" | "ready" | "unavailable";
  /** Last accepted schema-resolved section; undefined before the first acceptance. */
  readonly value?: unknown;
  /** Composition layer the Host resolved `value` over — what a cleared field reverts to. */
  readonly base?: unknown;
  /** Raw user layer as stored; a field's PRESENCE here marks it overridden. */
  readonly user?: unknown;
  /** Entry revision fencing the next write; undefined before the first Host view. */
  readonly revision?: number;
  /** Whether the Host document accepts writes (`:26-27`). */
  readonly writable?: boolean;
}

/**
 * One ordered field operation a `mutate` call submits
 * (`SettingsPathOpView`, `@deepseek-ai/dsh-settings` `types.d.ts:47-54`).
 * `path` starts at the field name; the card writes top-level fields only.
 */
export type SettingsPathOpLike =
  | { readonly op: "set"; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: "unset"; readonly path: readonly string[] };

/**
 * The form face the `plugins.row.config` owner props hand in
 * (`ConfigForm<T>['mutate']`, `config-form-types.d.ts:42-52`).
 *
 * `mutate` queues ONE atomic namespace mutation: all operations share one
 * revision fence and one recovery read, and it resolves `true` only for Host
 * acceptance — a refusal or a skipped write resolves `false` (transport
 * failures reject).
 */
export interface ConfigPageFormLike {
  /** Accepted Host values, refreshed by the page owner. */
  readonly state: ConfigFormSnapshotLike;
  /** Submit all field edits together with the revision the editor read. */
  mutate(
    ops: readonly SettingsPathOpLike[],
    expectedRevision?: number,
  ): Promise<boolean>;
}

/**
 * The `plugins.row.config` slot's owner props
 * (`PluginConfigViewProps`, `dsh-client-ui-plugin-manager`
 * `lib/types/client/slot-contract.d.ts:21-28`): `summary` renders the row's
 * one-liner, `page` renders the form with its save control.
 */
export interface PluginConfigViewPropsLike {
  readonly view: "summary" | "page";
  /** Present only on a row the Host serves a settings namespace for (`:26-27`). */
  readonly form?: ConfigPageFormLike | undefined;
}

/**
 * One entry's shared form over the settings domain's describe mirror
 * (`ConfigForm<T>`, `config-form-types.d.ts:33-71`), narrowed to the reads
 * and the one atomic write this module may need. The settings page itself
 * takes its form from the slot props; this face is what the declared
 * `configForms` service provides for a page that must resolve its entry id.
 */
export interface ConfigFormLike {
  /** The current sync snapshot (stable reference until the next change). */
  getSnapshot(): ConfigFormSnapshotLike;
  /** Queue one atomic namespace mutation; `true` means Host acceptance. */
  mutate(
    ops: readonly SettingsPathOpLike[],
    expectedRevision?: number,
  ): Promise<boolean>;
}

/** The `ctx.configForms` service face (`ConfigForms`, `config-form.d.ts:104-152`). */
export interface ConfigFormsLike {
  /** The shared form for one Host plugin entry id (`:137`). */
  get(entryId: string): ConfigFormLike;
}

/** Cordis effect seat shared by host and client fibers. */
export interface ClientEffectContext {
  effect(execute: () => unknown, label?: string): unknown;
}

/**
 * The session-scoped conversation face: the scope-addressed plain-prompt
 * sink plus the optional pagination verb. Every verb must be called as a
 * METHOD of this face (never detached) — the host rebinds `this.ctx` to the
 * accessing scope through the service tracker, and a detached call loses it.
 */
export interface ScopedConversationLike {
  /** Send a prompt into the scoped session (queued user turn). */
  send(text: string): Promise<void>;
  /**
   * Pull one older history page for the scoped session (ticket 80; the
   * scope-addressed pagination verb — `IConversation.loadOlder`,
   * dsh-client-ui-conversation `client/service.d.ts:52-55`). Optional: a
   * runtime without it degrades to a transcript without the older-pages
   * affordance, never to a fabricated one.
   */
  loadOlder?(): Promise<void>;
}

/**
 * A session-scoped context view (`ctx.sessions.scope(id)`, ticket 36 seam
 * 2/3): a use-and-discard Agent-scoped context whose scope-addressed
 * conversation face carries the plain-prompt sink. The host's own error copy
 * names that face ("address one via ctx.sessions.scope(id).conversation"),
 * and `send` puts the text into that session as the user's own queued turn —
 * but the face is reached through the service-method boundary, never the
 * property read (the block below).
 *
 * **Reach the service through `get(name)`, not the property read** (ticket
 * 92, verified 2026-09-19): the cordis context proxy resolves a service
 * PROPERTY read by walking the FIBER chain from the accessing context
 * (`cordis/lib/index.js:672-694`); the scope fiber is the no-op `agentScope`
 * plugin (`dsh-api-session-controller/lib/types/client/scope.js:21-36`), so
 * the walk leaves the sessions plugin's fiber and reaches the root fiber,
 * where `fiber.runtime === null` throws `cannot get property "conversation"
 * without inject` — the conversation service is provided by a CHILD plugin
 * of the conversation module's fiber
 * (`dsh-client-ui-conversation/lib/client.js:16837`), never on the scope
 * fiber's ancestor chain. `get(name)` is the service-method boundary: it
 * resolves through the isolate-keyed service store with no fiber walk, and
 * still rebinds `this.ctx` to the accessing (scoped) context, so the host's
 * own `scopeOf(this.ctx)` check (`dsh-client-ui-conversation/lib/client.js
 * :3170-3181`) finds the session tag. That is the host's own scoped call
 * shape (`:16500-16506` `scopedConversation`, `:14375-14377` the queue
 * dock). `src/client/actions.ts`'s `scopedConversation` helper owns the
 * resolution; the property read survives there only as a structural
 * fallback for a runtime whose context has no `get`.
 */
export interface ScopedAgentContextLike {
  /**
   * The service-method boundary (`ctx.get(name)`; cordis `reflect.get`,
   * `cordis/lib/index.js:762-764`) — the verified way to reach a service
   * from a session-scope context. Optional so a structural runtime without
   * it can still be addressed through the property fallback.
   */
  get?(name: string): unknown;
  /**
   * The property read — present on the scope context, but it THROWS on the
   * live host's composition (the doc block above); never the primary shape.
   */
  conversation?: ScopedConversationLike;
}

/**
 * One row of the standard sessions feed (`SessionSummary`, structural
 * minimal — ticket 79). `displayTitle` is the host's human-facing label
 * (durable title, project basename, then session id); `origin:
 * "subagent"` marks worker runs, which are leaves and never sidebar rows.
 */
export interface ClientSessionSummaryLike {
  readonly id: string;
  readonly displayTitle?: string;
  readonly title?: string;
  readonly origin?: string;
}

/**
 * The standard sessions-feed snapshot (`SessionListState`, structural
 * minimal — ticket 79). The sidebar projects its rows; `current` is the
 * selection the capsule actions already read. Fields stay optional so a
 * runtime serving an older face degrades instead of lying.
 */
export interface ClientSessionsFeedSnapshotLike {
  readonly ids?: readonly string[];
  readonly byId?: Readonly<Record<string, ClientSessionSummaryLike>>;
  readonly current?: string;
}

/**
 * The sessions service face the action wiring needs (ticket 36 seams 2/3):
 * the standard list snapshot (rows + current selection — widened to the
 * full feed face in ticket 79 for the wrapper sidebar's rows) and the
 * Agent-scoped context view (`undefined` for a session neither listed nor
 * already scoped). `open` (ticket 79) is the host's selection verb — the
 * shell sidebar rides it on row selection; optional because the shell
 * composition degrades to store-only selection without it. `binding`
 * (ticket 80) is the scope-addressed assembly feed whose `eventSource` is
 * the verified history-replay face (`wrapper-vehicle-seams.md` Finding 7;
 * `ISessions.binding`, dsh-api-session-controller
 * `client/contract/sessions.d.ts:118-123`); optional because a runtime
 * without it degrades the conversation pane to honest unavailability.
 */
export interface ClientSessionBindingLike {
  readonly eventSource?: ConversationSourceLike;
}

export interface ClientSessionsLike {
  list: {
    getSnapshot(): ClientSessionsFeedSnapshotLike;
    subscribe?(listener: () => void): () => void;
  };
  scope(id: string): ScopedAgentContextLike | undefined;
  open?(id: string): void;
  binding?(id: string): ClientSessionBindingLike | undefined;
}

/**
 * The conversation service face the action wiring needs (ticket 36 seam 3):
 * the per-session input resolver whose `for(actx)` facade exposes
 * `setDraft` (whole-draft programmatic write, caret at end). Focus is
 * deliberately absent — the composer editor is package-internal.
 */
export interface ClientConversationLike {
  input: {
    for(actx: unknown): { setDraft(text: string): void };
  };
}

/**
 * The remote command service face (ticket 36 seam 2): the composer's exact
 * command transaction — `execute(sessionId, line, attachments)` — resolving
 * to `undefined` when the line parses to no command.
 */
export interface ClientRemoteLike {
  commands: {
    execute(
      sessionId: string,
      line: string,
      attachments: readonly unknown[],
    ): Promise<unknown>;
  };
}

/**
 * The narrow client context this scaffold's `apply` needs. Ticket 84
 * corrected the access contract: the host's context proxy THROWS on any
 * service property the module's Cordis inject list does not declare
 * (`cannot get property "X" without inject`), wherever the read happens —
 * eager or inside a lazy closure. `slots`, `locale`, `sessions`, `remote`,
 * `conversation`, and `configForms` are therefore DECLARED in
 * `src/client/index.ts`'s `inject` export; they stay optional in this
 * STRUCTURAL type only, so offline fakes can omit them and the honest-degrade
 * branches stay exercisable. (The launcher-era `layout` face and the
 * `settingsScope` bind both left with the native-dsh posture; the settings
 * card now takes its form from the `plugins.row.config` owner props.)
 */
export interface ClientContext extends ClientEffectContext {
  slots: SlotsServiceLike;
  locale: LocaleServiceLike;
  remote?: ClientRemoteLike;
  sessions?: ClientSessionsLike;
  conversation?: ClientConversationLike;
  configForms?: ConfigFormsLike;
}
