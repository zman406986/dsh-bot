# 23 — Access-request prompt relay via host prompt seams

**Blocked by:** 19 (activation lifecycle — prompts belong to the activated dispatcher session).
**Status:** open

## Problem

Ticket 13's relay surfaces worker access asks conversationally (in dispatcher wake turns) with deny-by-default timeout (ADR-0008). Design 16 (§4.4) upgrades the answer surface: pending asks can be put to the user through dsh's **existing** host prompt seams — `ctx.userQuestions.ask` (research Finding 3, `dsh-user-questions lib/index.js:52`) for the structured ask — with answers routed into the unchanged core relay. No new prompt pathway may be invented.

## What to do

- [x] Host: when the dispatcher session is activated and the core holds pending access asks (`src/core/access-relay.ts`), emit a structured user question per ask via `ctx.userQuestions.ask` (copy from design §6: "Worker {workerId} needs approval to {action}." with Allow/Deny options). Map the answer into the same entry point a conversational answer uses today — the relay, timeout, and decision plumbing are untouched.
- [x] Preserve ADR-0008 exactly: an unanswered prompt falls to the existing deny-by-default timeout; a denied request is reported as a denied action; no stream waits indefinitely. The prompt is an additional answer *surface*, never a second decision state machine.
- [x] Dedupe: an ask already surfaced as a prompt must not also re-render conversationally mid-wait (and vice versa) — pick one presentation per ask at a time and record the rule in the ticket comments.
- [x] Fallback: if `ctx.userQuestions.ask` proves unavailable or behaves differently host-side than the `.d.ts` contract at integration, keep the shipped conversational relay (already correct) and record the deferral — do not build a custom prompt UI; `conversation.approval.detail` is a shipped-owned shadowing slot (design §4.4 forbidden list).
- [x] Tests (offline, extending `test/access-relay.test.ts` patterns): pending ask → prompt emitted with exact copy; answer routed → same relay transition as the conversational answer; no answer → timeout deny path unchanged; dedupe rule holds; secret values never appear in prompt payloads (ticket 13 invariant).

## Constraints

- Offline tests only (S8): FakeDshHost / fake prompt seam; no network, no LLM, no running dsh.
- Clean-room: prompt copy new; never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree.
- Secrets: prompt payloads carry class/action metadata only — never credential values (ticket 13 / `AccessDecision` has no value field).

## Comments

### 2026-09-17 — agent team

**Landed** (commit `38750b9`, "Surface access-request prompts through approval seam (ticket 23)"):

- `src/adapter/access-prompt.ts` (new): the prompt surface. Structural
  `UserQuestionsLike` view of the shipped `dsh-user-questions` contract
  (`ask({questions: [{id, question, detail?, options?}], agent?, signal?}) →
  {answers: [{id, selected}]}` — shapes read from the installed MIT dsh
  `lib/types/*.d.ts`, same source the research note cites; no runtime
  verification against a live host). `accessPromptQuestion` renders the
  design-16 §6 template exactly; `parseAccessPromptAnswer` maps ONLY an
  explicit Allow/Deny selection — dismissed, custom-text, unknown-label, or
  missing answers resolve nothing so the relay's armed timeout keeps
  deciding (both labels at once fails closed to deny).
  `createAccessPromptPump` is the presentation loop: `sync()` presents each
  not-yet-presented pending ask of the activated session, forwards explicit
  answers through `Multitask.resolveAccess` (the same entry point a
  conversational answer uses), prunes + aborts prompts whose ticket resolved
  elsewhere (timeout/clear/settle), and never re-prompts.
- `src/plugin.ts`: pump wired at apply — seam from the new optional
  `ctx.userQuestions` (`inject` grew by `"userQuestions"`, scaffold test
  updated); triggers are `host.onAccessRequest` (the core's own handler
  registered first, so the ticket is already parked when sync runs),
  `onActivated` (re-presents asks parked while dormant), `onDeactivated` +
  HMR dispose (`reset()` aborts outstanding prompts; tickets keep their
  armed timeouts). `composeWakeText` now filters prompted asks (dedupe);
  resolved-access denial notices are never filtered — honest reporting
  stays conversational.
- `src/adapter/cordis-dsh-host.ts` / `index.ts`: optional
  `AdapterContext.userQuestions` + exports.

**Dedupe rule (as required by the checkbox):** presentation is chosen by
activation state, not per-ask timing — while a dispatcher session is
activated AND the seam is present, every pending ask of that session is
prompt-presented and suppressed from conversational wake rendering; while
dormant or seam-less, the shipped conversational relay is the presentation
and nothing is suppressed (the wake flush is synchronous inside
`relay.noteRequest`, so per-ask timing cannot decide). If the seam fails for
one ask (throw / contract drift), that ask is *released*: suppression turns
off for it and it is re-queued through the core wake bus
(`enqueueAccessRequest` — the relay's own conversational path); a released
ask is never re-prompted. One presentation per ask at a time.

**Dormant/OFF behavior:** dormant (flag ON, not activated) — no prompts; asks
relay conversationally exactly as shipped (workers keep running across
deactivations; on the next activation their still-pending asks are surfaced
as prompts). Flag OFF — fully inert, no core, no prompts.

**Secrets safety:** prompt payloads carry class/action metadata only
(tool/credential/network/filesystem phrasing + target name; credential asks
carry the credential *name*). `AccessRequestBody`/`AccessDecision` have no
value field; tests assert no `value` key and no secret value in the encoded
payload.

**Tests:** suite 389 → **415 passing, 0 failing** (`npm test`); typecheck
clean on both configs. New `test/access-prompt.test.ts` (26 tests): exact
copy incl. credential-name-only + no-value-key; answer parsing incl. fail-
closed and never-invented decisions; pump surfacing/routing/dedupe/prune/
release/reset/inert; plugin integration over the real host seams — prompt
copy, Allow/Deny → relay delivery, timeout-deny with late no-op answer,
dedupe vs conversational wake, seam-failure conversational fallback, no-seam
fallback, deactivation abandon + settle clear, re-activation re-prompt,
dormant stock surface. All offline (S8), no real Cordis.

**Deferred gaps / notes for the next agent:**

- `ctx.userQuestions.ask` shapes match the shipped 0.1.5-rc.1 `.d.ts`, but
  live host behavior (answerer waterfall scoping via `agent`,
  `CALLER_NOT_LIVE`/`ASK_ABORTED` paths) is unverified offline — per the
  ticket fallback clause, if integration drifts, record the deferral; the
  pump degrades per-ask and the conversational relay remains correct.
- Re-queue on per-ask seam failure can double-render the ask
  conversationally in the narrow failure-before-wake-drain window; harmless
  (resolve is idempotent), accepted for v1.
- Pre-existing (out of scope, observed while testing): (1) a pending ask
  whose relay timeout fires after the parent unbind delivers its deny via
  `host.sendMessage`, which throws into a void'd promise inside
  `access-relay.ts` — potential unhandled rejection in the real host;
  (2) `test/access-relay.test.ts` T1/T7/T14 park tickets with the real
  120 s default timeout and never resolve, adding ~2 min to every suite run
  (the whole-suite `duration_ms ≈ 120190` is that file, not ticket 23).
