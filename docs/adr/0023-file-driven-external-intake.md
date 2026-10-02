# File-driven external work intake (inbox)

**Status:** accepted (human-ruled, 2026-10-02 in-session directive)

**Approval:** non-human — agent-drafted 2026-10-02 from the upstream-compare paperwork pass, pending human sign-off

**Numbering:** 0023, the first free number (0022 filed 2026-09-22). Companion ticket: 111 — the sign-off gate; no implementation starts before the human rules.

## Context

User-directed adaptation of an MIT-licensed upstream pattern (nescafe2009/dsh-grokbot v0.6.1 `src/inbox.mjs` — `queue.jsonl` + per-job dirs `prompt.md`/`reply.md`/`status.json`, rescan + watch, atomic writes, completion signaled by non-empty `reply.md` + `status.json` flip; lifecycle queued→claimed→replied|failed|cancelled).

Evidence recon 2026-10-02: the reference tree contains no file-driven intake mechanism (no `queue.jsonl`/`prompt.md`/`reply.md`/`jobId` hits anywhere; nearest analogues are a default-off in-app child-result inbox and an automations subsystem — see `docs/research/prd-vs-reference-capability-gaps.md` Gap 4). ADR-0018 authorizes imitation only and cannot cover a mechanism the reference lacks; ADR-0004 makes product goals (S1–S9) the source of scope additions. Gap 4 independently recommends a source-agnostic wake bus with timer/external-event sources; ticket 06 already shipped that vocabulary in the core wake-bus (`src/core/wake-bus.ts` — sources include `external-event`, currently unused).

## Decision (proposed, pending human sign-off)

Add an opt-in file inbox to the plugin.

1. **Intake:** config `inbox.enabled | inbox.dir | inbox.rescanIntervalMs` under the existing plugin Config/settings section; the adapter watches the dir (`fs.watch` + rescan-interval fallback); each queued job enters the wake bus as the existing `external-event` source — the inbox NEVER spawns workers (ADR-0003).
2. **Delivery:** with a live dispatcher session, external jobs open a dispatcher wake turn (keyed per session per ADR-0019 patterns) whose text presents the job prompt as work material; the dispatcher model decides spawning through the normal `spawn_worker` path; jobs create todos tagged inbox-origin so delivery routing is distinguishable.
3. **Reply:** when an inbox-origin todo's worker settles and delivery completes, the plugin writes `reply.md` (non-empty = done) + `status.json` (`{status, startedAt, endedAt, …}`) into the job dir (atomic tmp+rename), with `failed`/`cancelled` mappings from worker error/abort.
4. **No live dispatcher:** jobs remain queued and are re-presented on next activation (honest dormant posture, matching the ticket-58 redrive precedent).
5. **State:** job dedupe/checkpoint state in a storageDomain table (A5 — the watched dir is the external system's store, never ours); boot rescan flows through `rebuildFromDurability` + `redriveUndelivered` (ADR-0012).
6. **No client UI:** ADR-0014's client-inject record is untouched.

## Consequences

- First `fs` dependency in `src/` — filesystem watching lives in the adapter only, never core.
- The wake-bus `external-event` source gains its first producer.
- C15 respected: file jobs are ordinary dispatched workers, not new wake kinds.
- D21 clamps apply to job prompt/report text.
- PRD §6.4 (wake model) and §7.1 (component map) are amended via the companion ticket (111); the new config surface is documented in the settings section.
