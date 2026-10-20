# DD-117 — OS-level login machinery vs none
- **Area:** auth / account / secrets (A14)
- **Type:** missing-feature (host-app scope)
- **Date:** 2026-09-23

## What the reference does
The reference desktop app owns an end-to-end interactive sign-in flow in its main process:

- the reference tree's `source/electron-main/account/cursor-auth.ts` is a login service that (a) builds a sign-in URL plus PKCE-style verifier/challenge metadata, (b) polls for the login result with a hard cap of 150 attempts, abortable via an abort signal, and (c) classifies failure modes as dedicated error states — timed out, superseded by a newer attempt, sign-in expired — plus a sign-out path whose failure keeps a retained-credentials status variant so the UI can warn that the account may reappear after restart. It reads/writes OS-level secret storage through a secret-store interface and derives signed-in state from the access credential's claims.
- the reference tree's `source/electron-main/auth/auth-callback-registration.ts` registers the packaged app as the OS handler for a custom deep-link scheme (via Electron's `setAsDefaultProtocolClient`), so the provider's browser redirect lands back inside the installed app. Registration is skipped for non-packaged/lab builds, and the scheme is env-overridable but validated as a protocol-safe token.

## What the current build does
Nothing equivalent exists. A repo-wide search of `src/` for protocol registration, login polling, or login-result intake finds no matches (searches for the protocol-registration, login-start, and result-wait symbols: zero hits). In `src/core/dsh-host.ts` the only credential-adjacent surface is an optional `resolveCredential(name)` hook — resolving a credential *name* to a value for scoped worker injection (ADR-0008 routes credentials via `SpawnOptions.credentialNames`), which the Cordis adapter deliberately does not implement. In `src/adapter/cordis-dsh-host.ts` the only "poll" mentions are comments asserting the opposite design: activity updates are pure subscription, "no polling, no timers". The plugin never sees or handles provider credentials; that responsibility stays with the dsh host.

## The deviation
The reference is a full desktop-app login stack: OS protocol-handler registration, browser round-trip, bounded result polling, credential storage, and logout-with-retention handling. The current build has none of it — by design, since it is a Cordis plugin running *inside* the dsh host rather than a packaged Electron app of its own. The overlap is zero: the reference's machinery solves a problem (owning the packaged app's identity) that the dispatcher intentionally does not have.

## Verdict: DO-NOT-INCORPORATE
This is host-app plumbing — an OS protocol handler, a browser deep-link round-trip, bounded polling against the provider's auth service, and OS secret storage — all of which presuppose being the packaged desktop application. A Cordis plugin inside dsh cannot register protocol clients and should not own provider identity: the PRD's non-goals keep this project out of dsh's runtime/host concerns, and the build already routes any credential needs through the name-resolution hook (ADR-0008) rather than holding credentials itself. If dsh's own login flow ever needs patterns from here, that is dsh-side work, not dispatcher work — hence do not incorporate into this codebase.

## Incorporation notes
- **Where it would live:** Nowhere in this repo. Hypothetically, the *shape* (bounded-polling login service, deep-link callback registration as separate modules) would belong to the desktop host app layer, not `src/` core/adapter/worker/client.
- **Constraints:** A Cordis plugin has no access to Electron app APIs (`setAsDefaultProtocolClient`), no OS secret store, and must not hold provider credentials — injection via `SpawnOptions.credentialNames` (ADR-0008) is the only sanctioned path. ADR-0018 governs any re-derivation.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L (if ever needed host-side) — OS integration across Windows/macOS protocol registration plus secure storage; also out of scope per PRD non-goals, so the real risk is scope creep.
- **Key reference anchors:**
  - the reference tree's `source/electron-main/account/cursor-auth.ts` — the start-login URL/metadata build, capped result polling, timeout/superseded/expired error states, sign-out with retained-credential status fallback, secret-store interface.
  - the reference tree's `source/electron-main/auth/auth-callback-registration.ts` — packaged-only protocol registration via `setAsDefaultProtocolClient`, env-overridable validated scheme, redirect-target resolution.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/electron-main/account/cursor-auth.ts`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/electron-main/auth/auth-callback-registration.ts`
- Build: `src/core/dsh-host.ts` (only the `resolveCredential?` name-resolution hook, unimplemented by adapter); `src/adapter/cordis-dsh-host.ts` (subscription-only, explicit "no polling" comments); repo-wide `src/` grep for protocol-registration and login-polling symbols — no matches.
