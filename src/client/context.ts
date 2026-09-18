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
 */

import type { LocaleDictionary, SlotRegistrationOptions } from "./overlay.js";
import type { ToolviewRegistrationOptions } from "./toolviews.js";

/** Any slot entry this module registers: list entries (id/order) or keyed
 * entries such as the `tool.call.toolview` toolviews (key). */
export type SlotEntryOptions = SlotRegistrationOptions | ToolviewRegistrationOptions;

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
}

/** One namespace's bound settings scope (`SettingsScopeBinder.bind` result). */
export interface ClientSettingsScopeLike {
  /** The current sync snapshot (stable reference until the next change). */
  getSnapshot(): ClientSettingsScopeSnapshotLike;
  /** Observe snapshot replacements; returns the disposer removing this listener. */
  subscribe(listener: () => void): () => void;
}

/** The `ctx.settingsScope` binder face this module uses. */
export interface ClientSettingsScopeBinderLike {
  /** Bind one namespace scope on the caller's plugin lifecycle. */
  bind(spec: { readonly namespace: string }): ClientSettingsScopeLike;
}

/** Services handed to an `inject` callback child context. */
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
 * A session-scoped context view (`ctx.sessions.scope(id)`, ticket 36 seam
 * 2/3): a use-and-discard Agent-scoped context whose scope-addressed
 * conversation face carries the plain-prompt sink. The host's own guidance
 * for a root-scope plugin is to "address one via
 * ctx.sessions.scope(id).conversation" — `send` puts the text into that
 * session as the user's own queued turn.
 */
export interface ScopedAgentContextLike {
  conversation?: {
    /** Send a prompt into the scoped session (queued user turn). */
    send(text: string): Promise<void>;
  };
}

/**
 * The sessions service face the action wiring needs (ticket 36 seams 2/3):
 * the current session selection off the standard list snapshot (shipped
 * read idiom `list.getSnapshot().current`) and the Agent-scoped context
 * view (`undefined` for a session neither listed nor already scoped).
 */
export interface ClientSessionsLike {
  list: { getSnapshot(): { current?: string } };
  scope(id: string): ScopedAgentContextLike | undefined;
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
 * The narrow client context this scaffold's `apply` needs. The three action
 * services are OPTIONAL structural faces: they are always present in the
 * shipped web composition (connection/composer core), are read lazily at
 * send/click time (never declared as boot-time binds — ADR-0014's smallest-
 * set rule; same runtime-dynamic idiom as the settings watch), and a
 * runtime without them degrades to honest `no-channel`/copy-fallback UX
 * instead of blocking module materialization.
 */
export interface ClientContext extends ClientEffectContext {
  slots: SlotsServiceLike;
  locale: LocaleServiceLike;
  inject?: ClientInjectFn;
  remote?: ClientRemoteLike;
  sessions?: ClientSessionsLike;
  conversation?: ClientConversationLike;
}
