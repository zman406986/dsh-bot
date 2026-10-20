# DD-119 — OS-keychain secret store vs name-only relay posture
- **Area:** auth / account / secrets (A14)
- **Type:** deliberate-divergence (security stance)
- **Date:** 2026-09-23

## What the reference does
The reference desktop app keeps a real local secret store. The reference tree's `source/electron-main/secrets/user-secrets-store.ts` implements a per-account-slot store (an account-keyed encrypted-secrets map, with a legacy slot) persisted as a per-user secrets JSON file under the Electron userData path. Secrets are encrypted at rest via Electron `safeStorage` and only written while an account is signed in (a dedicated error is thrown for mutations with no account scope). If the OS keychain is unavailable, the store degrades to a session-only in-memory map with a one-time warning that nothing will survive a restart. Adjacent files (the reference tree's `secrets/secret-store.ts`, the secrets IPC layer) guard availability and expose the store to the renderer over IPC.

## What the current build does
The build never persists secrets anywhere. It deliberately relays names only: `src/core/access-types.ts` states the hard rule that no secret values appear on any of its types — only names. A credential access request carries a `credentialName` identifier (e.g. an env var name) plus a reason; the doc comments on the request and class shapes repeat that values never ride these messages. Decisions/consent (ADR-0011 approval-session scoping) answer whether a worker may proceed, and any actual secret value would be resolved by the host outside these message types. A repo-wide search of `src/`, `client/`, and `package.json` finds no safeStorage, keychain, or keytar usage.

## The deviation
The reference ships an OS-keychain-backed, per-account encrypted secret store with session fallback; the build deliberately has no secret persistence at all, relaying only credential names through consent. This is not a gap — the name-only rule is written into the message types themselves as a hard rule (ticket 13).

## Verdict: DO-NOT-INCORPORATE
The build's name-only rule is a recorded deliberate hard rule in `src/core/access-types.ts`, and adding a plugin-side secret store would reverse it — a major change to the security stance that widens the trust boundary and the damage any plugin compromise could do. Under the recorded authority order this is not something an agent picks up from reference parity: the PRD and the relay design treat the host/plugin boundary as the place where values stay out of scope, and nothing in the recorded decisions asks the plugin to hold secrets. If the product ever needs persisted credentials, that is a human ruling plus a new ADR, not an incorporation from this reference. Ask-human remains the path should a ticket request it.

## Incorporation notes
- **Where it would live:** (only under a future human ruling) a host-side or native-keychain bridge module outside `src/core/access-types.ts` — never inside those types; the plugin would still see names only.
- **Constraints:** name-only hard rule (access-types.ts) would need explicit human amendment; ADR-0011 consent layering must gate any value resolution; encryption only via the OS keychain mechanism (no homegrown crypto, no plaintext-at-rest fallback that persists); plugin runtime has no Electron main process, so `safeStorage` is not directly reachable — a host bridge or native helper would be required.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — new host/native bridge plus a policy-boundary change; high security risk and requires reversing a recorded hard rule.
- **Key reference anchors:** the reference tree's `source/electron-main/secrets/user-secrets-store.ts` (slots, sign-in gate, session fallback); the reference tree's `source/electron-main/secrets/secret-store.ts` and the secrets IPC layer (availability guard, IPC exposure) (DD number pending for their individual write-ups, if any).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/electron-main/secrets/user-secrets-store.ts`
- Build: `src/core/access-types.ts` (lines 1–36); no matches for safeStorage/keychain/keytar across `src/`, `client/`, `package.json` (git grep, 2026-09-23)
