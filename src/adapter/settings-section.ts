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
 * `enabled` for the *next* session without editing files. `onChange` is a
 * deliberate runtime no-op: the running session keeps its frozen flag.
 */

/** On-disk / in-UI settings namespace for this plugin. */
export const SETTINGS_NAMESPACE = "multitask-dispatcher";

/** Structural view of the hooks `installSection` accepts. */
export interface SettingsSectionHooksLike<T> {
  setSource?: (current: () => T) => void;
  onChange?: () => void;
  validate?: (value: T) => void;
}

/** Structural view of `ctx.settings` — only the method we call. */
export interface SettingsProviderLike {
  installSection(
    owner: unknown,
    ns: string,
    schema: unknown,
    entry: unknown,
    hooks: SettingsSectionHooksLike<unknown>,
  ): void;
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
 * - `setSource`: accepted and ignored. ADR-0005 forbids live re-read of
 *   the flag; the thunk is not consulted.
 * - `onChange`: runtime no-op. Persistence is the provider's job; the
 *   next `apply()` picks the new value up.
 */
export function installMultitaskSettingsSection(
  ctx: SettingsInjectContext,
  schema: unknown,
  config: unknown,
): void {
  ctx.inject(["settings"], (settingsCtx) => {
    const settings = settingsCtx.settings;
    if (settings === undefined) return;
    settings.installSection(ctx, SETTINGS_NAMESPACE, schema, config, {
      setSource: () => {
        // ADR-0005: frozen flag — never re-read config.
      },
      onChange: () => {
        // ADR-0005: next-session-only. No runtime teardown or rebuild.
      },
    });
  });
}
