# DD-106 — Frozen per-session `enabled` flag vs live-applied settings
- **Area:** settings (A12)
- **Type:** deliberate-divergence (recorded)
- **Date:** 2026-09-23

## What the reference does
Settings in the reference take effect immediately: the theme, permission, provider, and track controls are live controls — a change flows straight into the running app and the current behavior updates without a restart or a new session. A setting describes the running state; it is not a note stored for the next boot. (Per the DD-106 enumeration pass; exact reference file anchors pending from that pass.)

## What the current build does
The one dispatcher settings control, `enabled`, is deliberately not live. The plugin reads it exactly once when the plugin is applied, copies the primitive, and freezes it for that dispatcher session's lifetime (`src/plugin.ts:243-245`; Config doc `src/plugin.ts:47-56`). A change made in the settings card takes effect only in the *next* session. The settings section is installed on both flag paths via `register` with no `setSource`/`onChange` hooks, on purpose: the running session never re-reads the flag, so there is nothing for a change callback to do (`src/adapter/settings-section.ts:13-14`, rationale at `:121-123`). The card's own hint tells the user this: "Saved as the dispatcher's setting: it applies to new chats. The chat you are in keeps the flag it started with." (`client/index.js:109-110`.)

## The deviation
Where the reference's settings update the running app, the build's `enabled` is a next-session-only write: flipping it changes nothing in the current session, and no code path observes settings changes mid-session. The current session runs under the flag value it started with until the plugin session ends.

## Verdict: DO-NOT-INCORPORATE
The live-applied-settings pattern has nothing left to attach to. ADR-0018 supersedes ADR-0005's flag/toggle semantics outright — the dispatcher is always-on with no dispatcher mode or toggle, and the PRD's feature-flag/kill-switch sections (§11.5, §15.6) are voided — so the build's `enabled` is no longer a product mode switch but a leftover install-level kill switch (default `true`): flipping it OFF only makes the *next* plugin session boot stock (no core, no commands), and whether dispatch is actually active is decided per session by `/dispatcher-start` activation, which never consults the flag mid-session. Adding a live re-read would contradict the recorded frozen-flag approach still cited in both build files and would serve no product behavior ADR-0018 leaves standing. The flag's near-dead status under always-on is a possible cleanup ticket, not a reason to import the reference behavior.

## Incorporation notes
- **Where it would live:** nowhere by default. If the approach were ever reversed, the live path would be `setSource`/`onChange` hooks on the owner scope in `installMultitaskSettingsSection` (`src/adapter/settings-section.ts`) plus a change watcher in `apply` (`src/plugin.ts`) — both deliberately absent today.
- **Constraints:** ADR-0018 (accepted, human-ruled) supersedes ADR-0005's flag/toggle semantics, so no new work may treat ADR-0005 as authority for flag behavior; the frozen value must never reintroduce an "off while workers run" state; OFF affects only the next plugin session; whether dispatch is active per session stays with activation, not the flag.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S technically (an `onChange` hook plus a re-read is small); the risk is product-level — a live toggle contradicts ADR-0018's always-on ruling and would bring back the mode concept it voided.
- **Key reference anchors:** the reference settings surfaces where theme/permission/provider/track controls apply immediately to the running app (exact file paths: DD number pending).

## Evidence
- Reference: `C:\Users\TZhen\Desktop\dsh-bot\reference material-NOT LICENSE SAFE DONT COPY-grok bot` — settings screens where live controls flow into the running app (behavior per the DD-106 enumeration; exact anchors DD number pending).
- Build: `src/plugin.ts:47-56` (Config doc: read once at dispatcher-session start, frozen; change persists for next session only), `src/plugin.ts:243-245` (apply copies the primitive once), `src/plugin.ts:230-241` (apply doc: flag semantics + activation model); `src/adapter/settings-section.ts:13-14` (section installed on both flag paths for next-session flips), `:121-123` (no `setSource`/`onChange`; frozen flag, per ADR-0005 as cited); `client/index.js:109-110` (card hint states next-session semantics); `docs/adr/0005-feature-flag-session-scoped-toggle.md` (status: SUPERSEDED by ADR-0018 — flag/toggle semantics voided, dispatcher always-on with no mode); `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (no dispatcher mode or toggle, always-on; PRD §11.5/§15.6 flag sections voided).
