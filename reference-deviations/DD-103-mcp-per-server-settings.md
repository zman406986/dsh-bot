# DD-103 — Per-server MCP settings (instructions/tool toggles) vs none
- **Area:** settings (A12)
- **Type:** missing-feature (depends on MCP support that does not exist yet)
- **Date:** 2026-09-23

## What the reference does

The reference keeps two per-MCP-server settings collections in its settings store: a map from server id to custom instructions and a map from server id to a list of disabled tool names (`the reference tree's source/shared/node/settings/sand-settings-store.ts:22-23`, with the accessor cluster at lines 127-149). Around the two maps it maintains several supporting behaviors: a legacy mirror of the custom-instructions map keyed by server name that is kept in sync (or explicitly removed) on every per-server write, an account-scope concept that wipes all three maps when the signed-in account changes or scope is cleared, and a one-shot helper that migrates an old by-name instruction into the by-server-id map. Values are length-clamped, and a per-server write can delete the legacy entry when the new value is empty or matches the default.

The editing surface lives in the plugins feature, not in a settings page: the plugins browser overlay renders each MCP server with an account/summary model that carries custom instructions inline (`the reference tree's frontend/src/recovered/features/plugins/overlay/browser.tsx:660-672` and the account-manager panel), and a sibling module implements optimistic per-tool enable/disable toggling against a tool-summary list (that is, the toggle applies immediately and is corrected later if the server rejects it — `the reference tree's frontend/src/recovered/features/plugins/overlay/server-tools.ts:20-30`, 77-87).

## What the current build does

Nothing. A case-insensitive search for "mcp" across `src/` returns no files — the `multitask-dispatcher` settings surface has no MCP keys of any kind, no per-server instructions, no tool-disable lists, and no UI surface where a server's tools or instructions could be edited.

## The deviation

The reference treats MCP servers as first-class settings subjects: each server can carry its own injected instructions and its own list of disabled tools, keyed by a stable server id rather than a display name. The build has no MCP support at all, so this whole capability is absent — including the design lessons embedded in the reference's plumbing (keying by stable id, migrating legacy names, resetting on account scope). The feature cannot land independently of the MCP client itself.

## Verdict: ADAPT
The per-server settings are strictly dependent on the MCP client support, which is covered by its own filings (DD number pending, MCP machinery; `docs/adr/README.md` records no MCP decision yet), so nothing should be built now — but when that support lands, the settings design should be adapted, not skipped. The transferable insight is to key per-server instructions and tool toggles by a stable server id from day one, avoiding the reference's legacy by-name mirror and its migration helper entirely (we have no legacy installed base to migrate). The UI home should follow our own settings/connector card layout rather than the reference's plugins-browser overlay. Account-scope wiping is only worth carrying if our MCP servers are account-bound the same way — decide that inside the MCP-machinery ticket, not here.

## Incorporation notes
- **Where it would live:** settings-store extension alongside the other dispatcher settings (two keyed maps: server id → instructions, server id → disabled tool names), surfaced from the connector/plugin card UI once MCP support exists (DD number pending, MCP support).
- **Constraints:** key by stable server id, not display name; clamp instruction length; no by-name legacy mirror (no migration burden, since this build has no already-installed data to migrate); scope resets only if servers are account-bound; ADR-0018 B9 requires independent re-derivation of the store logic and the overlay interactions.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — the settings maps and UI toggles are small, but only schedulable after the MCP-machinery ticket lands, and the risk is designing the wrong keying before real server identity semantics exist.
- **Key reference anchors:** `the reference tree's source/shared/node/settings/sand-settings-store.ts:22-23,127-149` (maps, accessors, legacy mirror, account-scope reset, migration helper); `the reference tree's frontend/src/recovered/features/plugins/overlay/browser.tsx:645-690` (per-server panel with the custom-instructions field on the server summary); `the reference tree's frontend/src/recovered/features/plugins/overlay/server-tools.ts:20-30,77-87` (optimistic per-tool toggles).

## Evidence
- Reference: `the reference tree's source/shared/node/settings/sand-settings-store.ts` (keys at 22-23; accessor/migration/reset cluster at 127-149); `the reference tree's frontend/src/recovered/features/plugins/overlay/server-tools.ts` (tool toggles); `the reference tree's frontend/src/recovered/features/plugins/overlay/browser.tsx` (per-server panel, custom-instruction field on the server summary model).
- Build: `src/` — zero matches for "mcp" in any TypeScript file; `multitask-dispatcher` namespace carries no MCP settings keys and no per-server UI.
