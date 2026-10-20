# DD-118 — Inference-credential renewal service vs host-owned tokens
- **Area:** auth / account / secrets (A14)
- **Type:** missing-feature (host-app scope)
- **Date:** 2026-09-23

## What the reference does
The reference host carries a dedicated auth layer under the reference tree's `source/host/extensions/auth/`. Two files matter here. `credential-renewer.ts` implements a background renewal loop for short-lived inference credentials: it renews ahead of expiry with a leeway margin, retries failures with exponential backoff, redacts errors so failures never leak sensitive material into logs, and supports a development mode that reads the credential from a local file instead of the live backend. `auth-service.ts` sits above it as the host's credential store and authority: renewal can be triggered on demand, other components subscribe to renewal events as listeners, and the service identifies the machine so the backend can scope what it issues. Together they keep the rotating backend credential fresh with no desktop-side involvement.

## What the current build does
The dsh multitask dispatcher plugin has no notion of an inference credential at all. Model access is owned by the dsh host: the plugin's own "credential" vocabulary in `src/` refers to the access/approval policy system (grant scoping for workers and tools), not to model authentication. A tree-wide search of `src/` finds no renewal, refresh, or token-caching logic of any kind — the plugin consumes whatever access the host already provides and never touches credential lifecycles.

## The deviation
The reference keeps a rotating backend credential fresh inside its host via an automatic renewal service; the build has no counterpart. The absence is real, but it is absence at the wrong layer to fix in the plugin: in the reference this code lives in host extensions (desktop-app scope), and in the dsh architecture the equivalent responsibility belongs to the dsh host, which already owns model access. The plugin neither holds nor renews credentials by design.

## Verdict: DO-NOT-INCORPORATE
A Cordis plugin sitting beside dsh must never hold or rotate model credentials — this is host scope by construction, matching where the reference itself puts the code (its host extension layer, not its plugin surface). ADR-0018's exception-list rule supports copying the reference only where the build's layering allows it, and here the layering forbids it: the renewal duty belongs to dsh's account/auth layer, which exists independently of this plugin. Nothing in `src/` should grow a renewal loop, a credential store, or renewal listeners; if dsh's host ever lacks this capability, that is a dsh-side work item, not a dispatcher ticket. Recorded as a deviation so the survey is honest about the gap without licensing plugin-side credential handling.

## Incorporation notes
- **Where it would live:** Nowhere in this plugin. If ever pursued at all, it belongs in the dsh host's account/auth layer (host-owned, outside `src/` of this repo's plugin surface).
- **Constraints:** The plugin must never store, observe, or rotate model credentials; no second credential store alongside dsh's (same spirit as ADR-0018 A5's "no second store" rule); any renewal symptom visible to users should surface through the existing host-owned access/approval paths, not a plugin-side mechanism.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — no plugin work; at most a note to the dsh host owner if renewal coverage there is ever found lacking.
- **Key reference anchors:** the reference tree's `source/host/extensions/auth/credential-renewer.ts` (renewal loop, expiry leeway, exponential backoff, error redaction, dev file mode); the reference tree's `source/host/extensions/auth/auth-service.ts` (credential store, on-demand renewal, renewal event listeners, machine id).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/auth/credential-renewer.ts`, `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/auth/auth-service.ts`
- Build: `src/` — grep confirms zero occurrences of renewal logic; the only "credential" hits are access/approval-policy scoped (`src/core/access-types.ts`, `src/core/types.ts`, `src/core/dsh-host.ts`, `src/adapter/cordis-dsh-host.ts`, `src/worker/prompt.ts`, and related client/approval files)
