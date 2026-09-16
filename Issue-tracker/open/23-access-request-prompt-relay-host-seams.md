# 23 — Access-request prompt relay via host prompt seams

**Blocked by:** 19 (activation lifecycle — prompts belong to the activated dispatcher session).
**Status:** open

## Problem

Ticket 13's relay surfaces worker access asks conversationally (in dispatcher wake turns) with deny-by-default timeout (ADR-0008). Design 16 (§4.4) upgrades the answer surface: pending asks can be put to the user through dsh's **existing** host prompt seams — `ctx.userQuestions.ask` (research Finding 3, `dsh-user-questions lib/index.js:52`) for the structured ask — with answers routed into the unchanged core relay. No new prompt pathway may be invented.

## What to do

- [ ] Host: when the dispatcher session is activated and the core holds pending access asks (`src/core/access-relay.ts`), emit a structured user question per ask via `ctx.userQuestions.ask` (copy from design §6: "Worker {workerId} needs approval to {action}." with Allow/Deny options). Map the answer into the same entry point a conversational answer uses today — the relay, timeout, and decision plumbing are untouched.
- [ ] Preserve ADR-0008 exactly: an unanswered prompt falls to the existing deny-by-default timeout; a denied request is reported as a denied action; no stream waits indefinitely. The prompt is an additional answer *surface*, never a second decision state machine.
- [ ] Dedupe: an ask already surfaced as a prompt must not also re-render conversationally mid-wait (and vice versa) — pick one presentation per ask at a time and record the rule in the ticket comments.
- [ ] Fallback: if `ctx.userQuestions.ask` proves unavailable or behaves differently host-side than the `.d.ts` contract at integration, keep the shipped conversational relay (already correct) and record the deferral — do not build a custom prompt UI; `conversation.approval.detail` is a shipped-owned shadowing slot (design §4.4 forbidden list).
- [ ] Tests (offline, extending `test/access-relay.test.ts` patterns): pending ask → prompt emitted with exact copy; answer routed → same relay transition as the conversational answer; no answer → timeout deny path unchanged; dedupe rule holds; secret values never appear in prompt payloads (ticket 13 invariant).

## Constraints

- Offline tests only (S8): FakeDshHost / fake prompt seam; no network, no LLM, no running dsh.
- Clean-room: prompt copy new; never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree.
- Secrets: prompt payloads carry class/action metadata only — never credential values (ticket 13 / `AccessDecision` has no value field).
