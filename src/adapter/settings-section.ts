/**
 * Settings identity for this plugin (ticket 12 / ADR-0005).
 *
 * 0.2.1 has no settings registration API: `ctx.settings` only serves forms
 * derived from each Loader entry's own `Config`, and `describe()` keys them by
 * the entry's profile-row id. There is nothing to claim here — this constant
 * is that row id, and it must equal the `id:` of the plugin row in every
 * insertion path (`cordis.patch.yml`, the profile patch, `dev/cordis.web.patch.yml`).
 * Two rows with one id make `configEditor.entries()` drop the id and the form
 * disappears.
 *
 * Only `Config` fields marked `.volatile()` are editable; an undeclared key
 * written through the settings service is rejected (`Config field "<key>" is
 * not volatile`).
 */

/** Profile row id and settings namespace for this plugin. */
export const SETTINGS_NAMESPACE = "multitask-dispatcher";
