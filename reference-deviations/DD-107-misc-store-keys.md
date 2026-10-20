# DD-107 — Remaining store keys with no build counterpart (grouped)
- **Area:** settings (A12)
- **Type:** missing-feature (grouped; mostly filed elsewhere)
- **Date:** 2026-09-23

## What the reference does
The stored settings object (the reference's stored-settings type) carries a tail of keys beyond the ones the build's settings work already tracks, each with a getter/setter pair on the store:

- the push-notification config slot — persisted push-notification config; both the getter and the setter force-write a single disabled shape, so the value can never be anything but off (`sand-settings-store.ts:150-151`).
- the concierge-consent slot — tri-state record (not-yet-set / allowed / denied) of user consent for the concierge feature (`:24, :58`).
- the onboarding-seen slot (plus a companion key for the account scope) — a one-time onboarding-seen flag, with a per-account companion so a different sign-in can be shown onboarding again; an account rescope can clear it or carry it over (`:25, :61-62, :108-110, :134`).
- the pinned-agent-ids slot — deduplicated list of pinned sidebar agent ids (`:31, :88, :170-171`).
- the custom-sidebar-sections slot — custom sidebar section layout (id, name, member agents, collapsed fold), normalized through the shared sections helper on read and write (`:31, :89, :172-174`).
- the box-runtime slot — selected sandbox box runtime, falling back to a shared default (`:30, :73, :115-116`).
- the egress-tunnel toggle slot — egress tunnel toggle, surfaced outside the settings overlay via the Updates panel switch (`:22, :53, :117-118`).
- the WebAuthn-proxy toggle slot — WebAuthn proxy toggle, defaulting to enabled (`:22, :54, :119-120`).
- the MCP-box-server list slot — deduplicated list of MCP box server names (`:22, :51, :141-142`).

## What the current build does
ABSENT. None of these keys exist anywhere in the build: a search across `src/` and `client/` for the eight distinctive names (notifications config aside, which is covered by DD-218) returns zero hits, and the build's settings persistence defines no matching getters or setters. Onboarding itself was declared out of scope; only the stored flags are noted here.

## The deviation
The reference's settings store reserves storage slots for a cluster of features the build has no counterpart for. No single feature is missing here that isn't already owned by another filing — what remains is the store plumbing itself: key names, defaults, parse/normalize rules, and getter/setter pairs that exist only to serve those absent subsystems.

## Verdict: DO-NOT-INCORPORATE
Every key in this cluster belongs to a subsystem already decided elsewhere in the precedence order: notifications → DD-218, the onboarding-seen flags → DD-119, pins → DD-085, custom sections → DD-086, and the box-runtime / webauthn-proxy / MCP-box-server and concierge-consent keys go with the auth + MCP filings (DD number pending). Since each feature's absence is ruled (ADR-0018 remains the human-ruled master among accepted ADRs), storing orphaned keys or getter/setter scaffolding for them would add dead surface, not fidelity. The right behavior is to re-derive a store slot only if and when one of the separately filed deviations is itself incorporated — that filing then owns the key's shape, default, and migration handling (see DD-104), not this one. No conflict here rises to ASK-HUMAN.

## Incorporation notes
- **Where it would live:** N/A as a group. If a separately filed DD flips to INCORPORATE, its store slot belongs beside the build's existing settings persistence under `src/` (core settings layer), with the client surface in that filing's scope — e.g. pins/sections slots would live with the sidebar model, notifications with the DD-218 host.
- **Constraints:** no verbatim copying; any later key must be re-derived against the build's own storage shape, including versioning/migration behavior per DD-104; defaults must be re-derived, not transcribed (e.g. the reference's webauthn-proxy default-on is a design choice, not a fact).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — no direct work; the only risk is drift if a separately filed subsystem is later incorporated without revisiting its store key under this filing.
- **Key reference anchors:**
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/shared/node/settings/sand-settings-store.ts:21-35` — stored-shape interface and defaults
  - `.../sand-settings-store.ts:108-119` — onboarding, box-runtime, egress, webauthn getters and setters
  - `.../sand-settings-store.ts:141-142, :150-151, :170-174` — MCP box servers, notifications force-write, pins and sections getters and setters

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/shared/node/settings/sand-settings-store.ts` (lines 21-35, 53-54, 58, 61-62, 67, 73, 88-89, 108-119, 134, 141-142, 150-151, 170-174)
- Build: `src/` and `client/` — recursive search for the eight distinctive key names listed above returned no matches (grep exit 1, zero hits)
