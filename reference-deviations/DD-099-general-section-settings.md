# DD-099 — General settings group (theme/timezone/permission/security/account) vs two plugin controls
- **Area:** settings (A12)
- **Type:** missing-feature (host/account-dependent)
- **Date:** 2026-09-23

## What the reference does

The reference client's General settings panel (`the reference tree's frontend/src/recovered/features/settings/overlay/panels.tsx`, the general-settings panel component at line 92) groups several distinct concerns under one surface:

- **Appearance:** a theme select over system, light, and dark (the theme-preference options constant, line 38).
- **Agent group:** a timezone select backed by a stored value with an override field (auto-detected by default), a local tool permission select over three levels (allow, ask, or block) whose disallowed options are disabled by a ceiling an admin sets, and an entry point for auto-review instructions.
- **Security Key:** a switch that only appears on darwin/win32 (per the enumeration; the panel takes a platform prop).
- **Account:** an account card with pending/error states and per-action callbacks.

These are persisted in the shared settings store (`the reference tree's source/shared/node/settings/sand-settings-store.ts`): a theme-preference field (field at line 25, accessor pair at 113–114), a user-timezone field with its override counterpart (field at 27, accessors at 136–140 with the override winning over the detected value), a local-tool-permission field with its ceiling counterpart (field at 28, resolution at 154–157 where the stored choice is resolved against the ceiling, setter for the ceiling at 169), plus auto-review instructions and clearing when the account changes (around 135–140: a scope change drops the per-account permission/ceiling/model state).

## What the current build does

The settings surface in `src/client/settings-card-store.ts:203-214` (`SETTINGS_CARD_FIELDS`) renders exactly two controls — an `enabled` boolean and an `accessRequestTimeoutMs` number — in schema order. A comment pins the pair offline against the host half's `Config` dict in `src/plugin.ts`, so adding a schema field without a control fails the suite rather than silently hiding part of the namespace. The `enabled` hint is worded as a saved setting (ADR-0005), not a live toggle. There is no theme, timezone, tool-permission, security-key, or account surface anywhere under `src/client`.

## The deviation

The reference's General section is a whole host-application settings surface; the build exposes only the two config fields the dispatcher plugin itself owns. None of the reference's General-section features (theme select, timezone detection/override, local tool permission with admin ceiling, security-key switch, account card) exist in the build client. This is a scope difference, not an accidental omission: the build card is deliberately tied to the plugin's host `Config` field by field, whereas the reference panel sits in front of a shared settings store that spans many concerns and belongs to a full desktop product with an account system.

## Verdict: DO-NOT-INCORPORATE

The General section as a group is a host-app surface — theme, account, and security key are concepts of the surrounding desktop product, not of a Cordis dispatcher plugin, and pulling them in would chase the reference UI parity that the PRD's non-goals exclude. Two sub-items are nonetheless real and are already filed elsewhere: the theme sub-item is recorded under DD-014, and the local tool permission (with its admin ceiling) is the subject of the tool-permission deviation filing (DD number pending, tool-permission setting — A28's filing), which should be consulted for the only parts of this section worth acting on. Timezone, account, and security-key sub-items stay out unless the host app grows the corresponding concepts. Per ADR-0018 (B9), anything eventually adopted must be re-derived independently from the plugin's own requirements.

## Incorporation notes
- **Where it would live:** nothing for this file's group as a whole; the separately filed sub-items live with DD-014 (theme) and the A28 tool-permission filing. If a host-side equivalent ever appears, its natural home is the host app's settings, surfaced to `src/client` only through the existing settings-scope snapshot mechanism — never as new plugin `Config` fields.
- **Constraints:** the settings card is checked offline against `Config.dict` field by field (`src/client/settings-card-store.ts:193-198`); any control added without a host `Config` field fails the suite by design. ADR-0005: settings are saved-for-new-chats, never live toggles. ADR-0018 B9: independent re-derivation only.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S for the no-action verdict (documentation only); the separately filed sub-items carry their own effort in DD-014 and the A28 filing.
- **Key reference anchors:**
  - `the reference tree's frontend/src/recovered/features/settings/overlay/panels.tsx` — the general-settings panel component (line 92), the theme-preference options constant (line 38), props for account/theme/timezone/local-tool-permission/security-key/auto-review/platform.
  - `the reference tree's source/shared/node/settings/sand-settings-store.ts` — the theme-preference field (25, 113–114), the user-timezone field and its override (27, 136–140), the local-tool-permission field and its ceiling (28, 154–157, 169), account-scope clearing (134–135).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/settings/overlay/panels.tsx`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/shared/node/settings/sand-settings-store.ts`
- Build: `src/client/settings-card-store.ts` (fields at 203–214, schema-pin comment at 193–198); no theme/timezone/permission/security/account surface under `src/client`
