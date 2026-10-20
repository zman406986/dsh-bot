# DD-121 — WebAuthn security-key ceremonies vs none
- **Area:** auth / account / secrets (A14)
- **Type:** missing-feature (host/gateway scope)
- **Date:** 2026-09-23

## What the reference does
The reference supports hardware security keys (YubiKey-style WebAuthn ceremonies) end to end:

- the reference tree's `source/node-agent-coordinator/webauthn/provider.ts` runs the gateway-side ceremony: it drives a request loop over an SSE channel, keeps the ceremony alive with heartbeats, re-establishes the channel on drop (reconnect), and consults a consent provider before proceeding. (Mechanism shape spot-verified: those concerns are all present in the file.)
- the reference tree's `source/node-agent-coordinator/webauthn/signer.ts` shells out to an external signer/helper binary (`spawn` on a configured binary-path setting) and tracks user-interaction states during the ceremony — presence required (a touch-your-security-key prompt), device selection, and PIN entry — surfacing failures such as a helper that would not start.
- the reference tree's `source/host/extensions/webauthn-proxy/` (`extension.ts`, `webauthn-proxy-bridge.ts`, `webauthn-proxy-marker.ts`) bridges the host/desktop side, relaying between the local authenticator and the coordinator.

## What the current build does
Nothing WebAuthn-shaped exists. A full search of `src/` finds no mention of webauthn, security keys, or any authenticator concept. The nearest functional analog is the access-ask/decision relay, which passes a yes/no approval between parties by name only — it has no notion of hardware possession factors, PINs, or touch presence.

## The deviation
The reference can gate sensitive actions behind a physical key: ceremony orchestration on the coordinator, an external helper binary doing the CTAP-side work with live touch/PIN/presence state, and a host extension tying the local device into the loop. The current build has no equivalent at any layer, so possession-factor authentication is simply not a capability the plugin offers.

## Verdict: DO-NOT-INCORPORATE
Per the recorded authority order, ADR-0018 limits this project to the dispatcher plugin (PRD scope), and hardware-key ceremonies are host/gateway infrastructure: they need the SSE ceremony channel on a coordinator, a local helper binary launcher, and a desktop-side bridge — none of which a Cordis plugin owns. Rebuilding them would also drag in non-goals (chasing reference binary/UI parity) that the PRD explicitly excludes. If possession-factor auth ever becomes a requirement, it belongs in the dsh host surface and should come back as a human decision, not plugin work.

## Incorporation notes
- **Where it would live:** if ever requested: host-side extension (dsh runtime, not this plugin) plus a coordinator ceremony endpoint; nothing fits under `src/` cleanly.
- **Constraints:** requires gateway SSE infrastructure, a locally installed signer helper binary, and desktop OS access to USB/NFC authenticators — all outside plugin reach; consent UX would need product rules that do not exist here (DD numbers pending for any related access-ask extensions).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — full ceremony stack across three tiers with hardware-in-the-loop testing; high integration risk and outside stated scope.
- **Key reference anchors:**
  - the reference tree's `source/node-agent-coordinator/webauthn/provider.ts` — SSE ceremony loop, heartbeat, reconnect, consent provider
  - the reference tree's `source/node-agent-coordinator/webauthn/signer.ts` — external helper spawn (configured binary path), presence/touch, device-select, PIN states
  - the reference tree's `source/host/extensions/webauthn-proxy/` — host bridge (`extension.ts`, `webauthn-proxy-bridge.ts`, `webauthn-proxy-marker.ts`)

## Evidence
- Reference: `source/node-agent-coordinator/webauthn/provider.ts`, `source/node-agent-coordinator/webauthn/signer.ts`, `source/host/extensions/webauthn-proxy/` (all under `reference material-NOT LICENSE SAFE DONT COPY-grok bot/`)
- Build: `src/` — zero matches for webauthn/security-key/authenticator; nearest analog is the name-only access-ask/decision relay in `src/` (client/worker relay path)
