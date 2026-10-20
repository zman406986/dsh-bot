# DD-128 — Reasoning-effort & model-selection machinery vs host defaults
- **Area:** inference routing & streaming (A15)
- **Type:** missing-feature (host-owned)
- **Date:** 2026-09-23

## What the reference does

The reference gives both inference backends first-class, per-session control over which model runs and how hard it thinks.

- **First direct backend path** (`provider-session.ts`): a helper resolves a reasoning-effort level spanning the minimal through extra-high effort tiers from a dedicated environment variable, falling back to parsing a reasoning-effort entry out of a per-backend CLI config file under the home directory (honoring a config-home environment override); the resolved value (or nothing) is spread into the session's parameters, alongside the model read from the same config sources. Auth and model identity both come from that on-disk config file.
- **Native-session path** (`cursor-session.ts`): model choice is an explicit structure (a requested-model shape: model id, a max-mode toggle, and free-form parameters). A default selection is exported with the max-mode toggle on and parameter pairs of high effort and fast mode enabled; a subagent helper derives per-purpose model selections (e.g. for summarization-style helper roles). The session also resolves a privacy mode through the auth layer.
- **Experiment surface** (electron-main): Statsig-backed experiments live under the reference tree's `source/electron-main/` (adapters/experiments, experiments runtime, production services), including model-override hooks — this is where the reference's per-purpose subagent models (summarization, computer-use, browser-use) get steered at runtime. (Those computer/browser-use subagent models are excluded scope; noted here only as a reference fact.)

## What the current build does

Nothing in `src/core` or `src/adapter` exposes a reasoning-effort level, a model id, a max-mode toggle, or any experiment/override setting. A grep across `src` for effort/model/experiment terms matches only "best-effort" prose comments — there is no selection machinery at all. Worker model choice is entirely whatever model the host's child-session default gives the spawned worker; the dispatcher neither reads nor forwards such settings. The closest equivalent is capability scoping, not model control: `SpawnOptions.credentialNames` (`src/core/types.ts`) lets a spawn request restrict which credentials a worker may use, threaded through `src/core/multitask.ts` into the adapter's spawn call, and the comments around `src/core/dsh-host.ts` and `src/adapter/cordis-dsh-host.ts` explicitly point at that field as the per-worker scoping point (ADR-0008) — deliberately *not* widening the dispatcher's control over the session itself.

## The deviation

The reference treats "which model, at what effort" as a per-session, operator- and experiment-steerable dimension of inference. The build has no such dimension: it is structurally absent, and per-worker differentiation stops at credential scoping. This is a deliberate-looking boundary rather than an oversight — the dispatcher's design keeps the child session's identity owned by the host — but it means a host today cannot say "run this worker's tasks on model X at high effort" through the spawn call. Cross-ref DD-122 (provider routing): that deviation covers *which backend* serves a request; this one covers the model/effort *parameters* within a backend, a layer below.

## Verdict: ADAPT

The capability is worth having, but the reference's shape must not be copied: env-var and `config.toml` parsing, Statsig experiments, privacy mode, and per-purpose subagent model overrides are client-app machinery foreign to a Cordis plugin, and the subagent-model part is excluded scope anyway. The adaptable core is narrow — an optional, host-configured model/effort field on the spawn request, riding `SpawnOptions` next to `credentialNames` so per-worker model control follows the exact scoping pattern ADR-0008 already established. Because this widens the PRD's spawn surface and touches the host-owned boundary that the current comments treat as settled, it should go through the PRD/ADR process before implementation; absent that ruling it stays host-default-only.

## Incorporation notes
- **Where it would live:** optional `model` / `reasoningEffort` fields on `SpawnOptions` in `src/core/types.ts`; threaded beside the existing `credentialNames` forwarding in `src/core/multitask.ts`; realized in the adapter's child-session spawn (and surfaced as Cordis plugin config in `src/adapter/cordis-dsh-host.ts`). No parsing of env vars or reference CLI config files — the host supplies values.
- **Constraints:** host-configured only, no runtime experiments or overrides; must not widen the dispatcher's authority over the child session beyond what ADR-0008 scoping already allows; per-purpose subagent models (summarization / computer-use / browser-use), Statsig experiments, and privacy mode are out of scope; PRD/ADR ruling required before the config surface is added (stack items 2–3).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — a passthrough field with host-side plumbing; risk is low technically, but the real question is whether the scope allows it.
- **Key reference anchors:** `provider-session.ts` effort-resolution helper (environment variable plus a reasoning-effort entry in a per-backend CLI config file under the home directory) and its spread into session parameters; `cursor-session.ts` default model-selection export (max-mode on, high effort, fast mode enabled), the requested-model shape, and the subagent model helper; the reference tree's `source/electron-main/adapters/experiments.ts` model-override hook (reference fact only, excluded scope).

## Evidence
- Reference: the reference tree's `source/host/extensions/inference/provider-session.ts` (effort + model from env/config file); the reference tree's `source/host/extensions/inference/cursor-session.ts` (default selection with high effort / fast mode / max-mode, requested-model shape, subagent models, privacy mode); the reference tree's `source/electron-main/adapters/experiments.ts`, `source/electron-main/experiments/experiments-runtime.ts`, `source/electron-main/main-production-services.ts` (Statsig-backed experiment and model-override surface)
- Build: `src/core/types.ts` (`SpawnOptions.credentialNames`, two declarations); `src/core/multitask.ts` (credentialNames forwarding at spawn); `src/core/dsh-host.ts` (comment: per-worker scoping via `SpawnOptions.credentialNames`, ADR-0008, not this interface); `src/adapter/cordis-dsh-host.ts` (same scoping note at the adapter boundary); negative grep of `src` for effort/model/experiment identifiers (all matches are "best-effort" comments)
