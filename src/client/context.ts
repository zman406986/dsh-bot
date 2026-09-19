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
 * - `ctx.settingsScope.bind({namespace})` returns that namespace's scope with
 *   `getSnapshot()`/`subscribe()` — the roster data path (ticket 46 corrected
 *   this from the host-side `settings`/`watch` shape; see the block below).
 *   The same scope's `set(field, value)`/`unset(field)` are the settings card's
 *   write path (ticket 47) — one bind, one channel, two honest readers.
 */

import type { LocaleDictionary, SlotRegistrationOptions } from "./overlay.js";
import type { ToolviewRegistrationOptions } from "./toolviews.js";
import type { SettingsCardRegistrationOptions } from "./settings-card-store.js";
import type { ConversationSourceLike } from "./conversation-store.js";

/** Any slot entry this module registers: list entries (id/order), keyed
 * entries such as the `tool.call.toolview` toolviews (key) and the
 * `settings.plugin.item` settings card (key), keyed `main` pages (key), and
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
 * Client-side settings scope (ticket 21 data path; contract corrected by
 * ticket 46 against the installed 0.1.5-rc.1 tree).
 *
 * The browser's settings base plugin (`@deepseek-ai/dsh-client-ui-settings`)
 * provides **`ctx.settingsScope`** — a `SettingsScopeBinder`
 * (`lib/types/client/index.d.ts:2-3`;
 * `declare module '@deepseek-ai/cordis' { interface Context { settingsScope } }`
 * at `settings-scope.d.ts:88-92`). There is NO client service named
 * `settings`; that name is the *host* seam (`ctx.inject(["settings"], …)` +
 * `installSection`, `src/adapter/settings-section.ts`). Ticket 46: the client
 * half had copied the host name, so `ctx.inject(["settings"], …)` waited on a
 * service that never resolves and its body never ran.
 *
 * Per-namespace access is a bind, not a watch: `bind(spec)` returns a scope
 * bound to the CALLER's fiber (`settings-scope.d.ts:130-139`) exposing
 * `getSnapshot()` + `subscribe(listener)` — there is no `watch(namespace, cb)`
 * anywhere in the contract (`settings-contract.d.ts:50-58`). Reads never touch
 * the wire here: the scope is a selector over the settings domain's one shared
 * describe mirror.
 */
export interface ClientSettingsScopeSnapshotLike {
  /**
   * `loading` until the first accepted section, `ready` while one stands, and
   * `unavailable` when the namespace is not exposed to this client or the
   * connection keeps preferences process-local
   * (`settings-contract.d.ts:6-12`).
   */
  readonly status: "loading" | "ready" | "unavailable";
  /** Last accepted schema-resolved section; undefined before the first acceptance. */
  readonly value?: unknown;
  /**
   * Composition layer the Host resolved `value` over, when the owning plugin
   * declared one — what a cleared field reverts to (`settings-contract.d.ts:16-20`).
   */
  readonly base?: unknown;
  /**
   * Raw user layer as stored, when one exists. A field's PRESENCE here is what
   * marks it overridden — an override whose value equals the composition
   * default is still an override, and comparing values could not see it
   * (`settings-contract.d.ts:20-25`). The settings card reads it (ticket 47).
   */
  readonly user?: unknown;
  /** Namespace revision fencing the next write; undefined before the first Host view. */
  readonly revision?: number;
  /**
   * Whether the Host document accepts writes; memory mode never does
   * (`settings-contract.d.ts:30`). Absent on a minimal scope, and absence is
   * NOT permission — the card treats a missing flag as read-only.
   */
  readonly writable?: boolean;
  /** `host` syncs with the Host document; `memory` keeps a browser process-local. */
  readonly mode?: "host" | "memory";
}

/** One namespace's bound settings scope (`SettingsScopeBinder.bind` result). */
export interface ClientSettingsScopeLike {
  /** The current sync snapshot (stable reference until the next change). */
  getSnapshot(): ClientSettingsScopeSnapshotLike;
  /** Observe snapshot replacements; returns the disposer removing this listener. */
  subscribe(listener: () => void): () => void;
  /**
   * Queue one field write, fenced by the namespace's latest known revision
   * (`settings-contract.d.ts:74-85`). Optional here so a scope-less or
   * write-less runtime degrades the settings card to read-only instead of
   * throwing; the shipped scope always provides it.
   */
  set?(field: string, value: unknown): Promise<void>;
  /**
   * Queue one field clear, so the field re-inherits the composition layer
   * (`settings-contract.d.ts:86-93`). Optional for the same reason as `set`.
   */
  unset?(field: string): Promise<void>;
}

/** The `ctx.settingsScope` binder face this module uses. */
export interface ClientSettingsScopeBinderLike {
  /** Bind one namespace scope on the caller's plugin lifecycle. */
  bind(spec: { readonly namespace: string }): ClientSettingsScopeLike;
}

/**
 * Services handed to an `inject` callback child context. Inside the callback
 * the requested faces are DECLARED on the child, so property reads resolve
 * instead of throwing the host's `cannot get property "X" without inject`
 * (ticket 84). The callback may return a disposer — the host collects it as
 * the wrapper fiber's teardown (run on service unload/replacement).
 */
export interface ClientInjectedServices {
  settingsScope?: ClientSettingsScopeBinderLike;
}

/**
 * Cordis-level `inject` used to wait for the optional settings service.
 * Optional on the context: a client runtime without it leaves the roster
 * channel missing and the panel degrades to unavailable copy.
 */
export type ClientInjectFn = (
  services: readonly string[],
  callback: (child: ClientInjectedServices) => void,
) => unknown;

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
 * and `conversation` are therefore DECLARED in `src/client/index.ts`'s
 * `inject` export; they stay optional in this STRUCTURAL type only, so
 * offline fakes can omit them and the honest-degrade branches stay
 * exercisable. `settingsScope` is the one genuinely OPTIONAL face, reached
 * through the runtime `ctx.inject([...])` idiom, never a bare read on this
 * context. (The launcher-era `layout` face — the `ClientLayoutLike`
 * structural type and the `ctx.inject(["layout"])` watch that delivered it,
 * tickets 78/84 — was DELETED with the launcher, ticket 89, 2026-09-19:
 * nothing in the live composition ever read it post-cutover.)
 */
export interface ClientContext extends ClientEffectContext {
  slots: SlotsServiceLike;
  locale: LocaleServiceLike;
  inject?: ClientInjectFn;
  remote?: ClientRemoteLike;
  sessions?: ClientSessionsLike;
  conversation?: ClientConversationLike;
}
