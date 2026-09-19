/**
 * Settings-section install for the feature flag (ticket 12 / ADR-0005).
 *
 * Structural typing only — no import from `@deepseek-ai/dsh-settings`.
 * Live dsh uses `ctx.inject(["settings"], cb)` so the section installs when
 * the provider appears; stub contexts either implement `inject` or omit it.
 *
 * Direct `ctx.settings` access throws on real Cordis ("cannot get property
 * ... without inject") unless the service is declared. Settings is deliberately
 * NOT in the plugin's static `inject` — it is optional, matching dsh's own
 * plugins (agent-default-model, permission-presets).
 *
 * The section is installed on BOTH flag paths so the user can flip
 * `enabled` for the *next* session without editing files.
 *
 * ## The owner scope comes from `register`, NOT from `installSection`
 * (ticket 93, 2026-09-19 — live-found: the channel never attached and zero
 * `roster.*` keys ever reached the settings document)
 *
 * Verified against the installed 0.1.5-rc.2 host tree (read-only):
 * - `SettingsProvider.installSection(owner, ns, schema, entry, hooks)`
 *   returns **void** — it calls `register(...)` internally and DISCARDS the
 *   scope (`@deepseek-ai/dsh-settings/lib/index.js:327-343`; the shipped
 *   type is `installSection(…): void`,
 *   `@deepseek-ai/dsh-settings/lib/types/index.d.ts:228`). The JSDoc above
 *   the implementation still claims "@returns the owner scope" — stale prose,
 *   the type is authoritative).
 * - `SettingsProvider.register(ns, schema, options?)` is the scope-returning
 *   API (`dsh-settings/lib/index.js:281-315`; the `{get, watch, update,
 *   replace}` scope is built at `:298-314`; types
 *   `SettingsScope<T>` at `types/index.d.ts:84-112`).
 * - The canonical host idiom for a plugin that needs a scope is therefore
 *   `settings.register(...)`: `@deepseek-ai/dsh-agent-presets/lib/index.js:1311-1318`
 *   (`ctx.inject(["settings"], (settingsCtx) => { this.settings =
 *   settingsCtx.settings.register(SETTINGS_NAMESPACE, Schema, { base }) })`).
 *   The host's own `installSection` consumers use only the hooks
 *   (`dsh-agent-default-model/lib/index.js:45-52`,
 *   `dsh-permission-presets/lib/index.js:123`) — never a return value.
 *
 * We drop `installSection` entirely rather than calling both: one namespace
 * can be claimed once (a second claim THROWS, `dsh-settings/lib/index.js:283`),
 * and the hooks it adds (`setSource`/`onChange`) were deliberate no-ops here
 * (ADR-0005: the flag is frozen for the session, never re-read live). The
 * registration itself — schema, composition `base`, `describe()` visibility
 * for the ticket-47 settings card — is identical either way, because
 * `installSection` routes through `register`.
 */

/** On-disk / in-UI settings namespace for this plugin. */
export const SETTINGS_NAMESPACE = "multitask-dispatcher";

/**
 * Structural view of the owner scope `settings.register` returns
 * (`dsh-settings/lib/index.js:298-314`: `{ get, watch, update, replace }`).
 * All methods optional so stub providers stay assignable. Ticket 21 uses
 * `update` to mirror the roster snapshot into the plugin's own namespace;
 * the client watches the same namespace from the browser side. The host's
 * `update` is ASYNC (`types/index.d.ts:105-108`) — see
 * `SettingsRosterChannel`, which contains the returned promise.
 */
export interface SettingsOwnerScopeLike {
  get?(): unknown;
  watch?(onChange: (value: unknown) => void): () => void;
  update?(value: unknown): unknown;
  replace?(value: unknown): unknown;
}

/** Optional extras for {@link installMultitaskSettingsSection}. */
export interface SettingsSectionInstallOptions {
  /**
   * Called when the settings service appeared and the section installed,
   * handing over the owner scope. Ticket 21's roster mirror uses this to
   * attach its write path (and catch up any snapshot already projected).
   */
  readonly onScope?: (scope: SettingsOwnerScopeLike) => void;
}

/** Structural view of `ctx.settings` — only the method we call. */
export interface SettingsProviderLike {
  /**
   * Claim this plugin's settings namespace and receive its owner scope
   * (host `dsh-settings/lib/index.js:281-315`). The registration is an effect
   * on the provider's fiber and a second claim of one namespace THROWS
   * (`:283`), so this is the ONE claim site per namespace.
   */
  register(
    ns: string,
    schema: unknown,
    options?: { base?: unknown; applies?: string },
  ): SettingsOwnerScopeLike;
}

/** Contexts that may carry a settings provider (child of inject). */
export interface SettingsAwareContext {
  settings?: SettingsProviderLike;
}

/**
 * Minimal Cordis inject surface used to wait for the optional settings service.
 * Live dsh implements this; unit stubs either provide it or we no-op.
 */
export interface SettingsInjectContext {
  inject(
    services: readonly string[],
    callback: (child: SettingsAwareContext) => void,
  ): unknown;
}

/**
 * Install the `multitask-dispatcher` settings section.
 *
 * Always called from `apply` — before the enabled check — so the control
 * is present even when the dispatcher is currently OFF.
 *
 * - Uses `ctx.inject(["settings"], …)` so real Cordis does not throw.
 * - Claims the namespace through `register(ns, schema, { base })` — the
 *   host's scope-returning API (ticket 93; `installSection` returns void on
 *   the live host, which is what starved the roster channel). `base` is the
 *   composition entry, so a cleared field reverts to it and the settings card
 *   can mark user overrides.
 * - ADR-0005 forbids live re-read of the flag, so no `setSource`/`onChange`
 *   bookkeeping is wanted; the running session keeps its frozen flag.
 * - The scope is handed to {@link SettingsSectionInstallOptions.onScope}
 *   when the provider appeared.
 */
export function installMultitaskSettingsSection(
  ctx: SettingsInjectContext,
  schema: unknown,
  config: unknown,
  options?: SettingsSectionInstallOptions,
): void {
  ctx.inject(["settings"], (settingsCtx) => {
    const settings = settingsCtx.settings;
    if (settings === undefined) return;
    const scope = settings.register(SETTINGS_NAMESPACE, schema, {
      base: config,
    });
    if (scope !== undefined && options?.onScope !== undefined) {
      options.onScope(scope);
    }
  });
}
