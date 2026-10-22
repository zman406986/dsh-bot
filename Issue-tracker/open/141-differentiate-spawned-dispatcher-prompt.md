# 141 — Should a dispatcher-spawned dispatcher get a different system prompt from a user-started one?

**Status:** open
**Labels:** needs-triage
**Blocked by:** a dated human decision — which option (if any) to build. This ticket records the research and the options; it does not rule.
**Related:** ADR-0025 (mitosis; decision 2 "full dispatcher tool surface and dispatcher policy", decision 6 "child routes through its creator"), ticket 118 (the spawn path), ticket 140 (spawned dispatcher glyph parity — adjacent identity question, different surface), ticket 138 (deferred resume/glyph), ADR-0003 (workers stay leaves), `docs/research/reference-subagent-inherited-sections.md`, `docs/research/reference-agent-prompt-inventory.md`

## Problem

Owner question, dated 2026-10-22 (verbatim):

> "dispatcher spawned dispatchers system prompt should probably be different from user spawned ones"

Today both paths get **byte-identical prompt text**. `activate()` and `activateSpawnedDispatcher()` both call the same private `bindActivation` (`src/adapter/parent-agent.ts:367-381`), which injects `assembleSessionPolicy(true)` → `buildDispatcherPolicySection()` (`src/core/policy/prompts.ts:135`). Same eight tools, same per-turn reminder, same peer roster.

Two statements in that shared text are false for a spawned dispatcher:

1. The opener says the reader is "the user's main assistant in this chat". A spawned dispatcher is neither the main assistant nor in a chat with the user.
2. "Workers never message the user. You deliver." A spawned dispatcher's `deliver_result` has no `deliverToUser` producer wired anywhere in `src/`, and unlike a user-started dispatcher it has no user-visible turn to fall back on (ticket 11's accepted gap does not cover it). Its work reaches the user only through its creator (ADR-0025 decision 6).

The peer roster is also unlabelled: a child sees its creator as one more peer, and vice versa.

## Research pointer

`docs/research/2026-10-22-reference-nested-dispatcher-prompts.md` — reference behavior for both Grok Bot and the third-party DeepSeek-Bot, plus the precise current-state diff and four options with tradeoffs.

Headline from the research: **neither reference has a nested-dispatcher prompt.** Grok Bot has no dispatcher-spawns-dispatcher path (the Task tool is gated on `!isSubagentRunner`); its `CreateAgent` produces an ordinary top-level peer with the same base prompt and full tool surface, and hard-codes `origin: "user"` even when an agent is the caller. DeepSeek-Bot puts the creator in a one-line kickoff *user message* and leaves the system prompt creator-agnostic. Both differentiate by **capability**, not prose.

## Options from the findings (no ruling)

| | Option | Pro | Con |
|---|---|---|---|
| A | Keep the text shared; append a short spawn-only section ("you were summoned; that session is your route to the user; report back") | Smallest change; peers-not-subordinates intact; fixes the two false claims | Needs a discriminator threaded from the activation path into `assembleSessionPolicy`; per-kind cache-prefix difference |
| B | Split policy into shared doctrine + per-kind opener | Removes the false identity line at its root; shared body cannot drift | Touches `POLICY_SECTION_HEADINGS` and every test pinning the section; largest diff |
| C | Differentiate by tools, not words (withhold `deliver_result` from a child) | Matches how both references actually differentiate | Reverses ADR-0025 decision 2 ("full dispatcher tool surface") — needs its own ticket; text still needs an edit |
| D | Prepend one provenance line to the spawn prompt, leave the system prompt alone | Cheapest; exactly what DeepSeek-Bot does | Lives in conversation content, so compaction can drop it (the failure mode register D-1 / ticket 55 moved the worker contract out of `request.prompt` to avoid) |

Option C is the only one that would need an ADR-0025 amendment. Option D is the only one that reproduces the closest analogue's behavior exactly.

## Acceptance

**Decision pending — owner picks an option (or rejects all four).** Implementation checkboxes below are placeholders to be filled in once the decision is recorded, not a pre-approved plan.

- [ ] Owner records the chosen option (A/B/C/D or other), dated, in the Comments section below.
- [ ] If the decision contradicts ADR-0025 decision 2 or 6, the ADR is amended or superseded by an explicit ticket before implementation.
- [ ] Implementation ticket(s) cut from the chosen option; this research ticket closes when the decision is recorded.

## Comments

2026-10-22: Filed by the research pass. No code changed. Claimed state verified by inspection: identical `bindActivation` for both entry points (`src/adapter/parent-agent.ts:367-381`); `spawnDispatcher` passes only `{prompt, parent, maxDepth}` with no preset, persona, or prompt variant (`src/adapter/cordis-dsh-host.ts:1349-1363`); no `deliverToUser` producer exists anywhere in `src/`. DeepSeek-Bot claims come from a third-party clone outside this repo at `C:/Users/TZhen/AppData/Local/Temp/gh-analysis/DeepSeek-Bot` (no in-repo DeepSeek reference folder exists); the Grok Bot claims come from the in-repo reference tree, read-only, no verbatim copying (ADR-0018 B9).

### 2026-10-22 — minimal truthfulness slice implemented

Scope: only the two factually false statements, and the one line whose trigger is unreachable for a child. No redesign, no new section, no rank wording. The user-started text is unchanged byte for byte (verified against `git show HEAD:src/core/policy/prompts.ts`).

**Line changes, spawned variant only (old → new):**

1. Opener (`src/core/policy/prompts.ts`, policy line 3)
   - OLD: `You are the user's main assistant in this chat. You stay responsive. Heavy work goes to workers you spawn in the background.`
   - NEW: `Another dispatcher summoned you. You are a dispatcher in your own session: you coordinate workers the same way, and your results go back to that dispatcher, not to a user. You stay responsive. Heavy work goes to workers you spawn in the background.`
2. Todo completion trigger (policy line 11)
   - OLD (prefix unchanged, trigger changed): ``Mark an entry `completed` at the first visible acknowledgement to the user — they have seen or been told the outcome is underway or delivered.``
   - NEW: ``Mark an entry `completed` at your first report of its outcome to the dispatcher that summoned you.``
   - Why: a spawned dispatcher has no user-visible turn, so the stated trigger can never occur.
3. Delivery line (policy line 14)
   - OLD: `- Workers cannot talk to the user. Only you deliver.`
   - NEW: `- Workers cannot talk to the user. Their results come back to you; yours go back to the dispatcher that summoned you.`

Exactly three of 28 policy lines differ; the other 25 are identical, including both `##` headings, the mitosis doctrine line, the stop rule, the poll rule, and the no-board rule.

**Reviewed and deliberately NOT changed** (checked against the research findings, not false for a child):
- `The user never hears the machinery.` — true; a child still has a user upstream.
- `If the user asks you to stop or change course…` and `Clone a stream because the user corrected it.` — unreachable for a child, but not false; the parent can relay a course change, and deleting them would fork the doctrine.
- `It cannot talk to the user, so its work reaches the user only through you.` (mitosis line inside the child's own copy) — true for any child the child later summons.
- The per-turn reminder and standing rules are unchanged. `first visible acknowledgement to the user` survives there; the reminder also carries the ledger, where marking `completed` still applies, so its wording was left alone. Flagged for the owner's full design pass.

**Wiring (smallest origin signal):**
- `src/core/policy/prompts.ts`: new exported `DispatcherOrigin = "user" | "spawned"`; `buildDispatcherPolicySection(origin = "user")`.
- `src/core/policy/assembler.ts`: `assembleSessionPolicy(enabled, origin = "user")` — default keeps every pre-141 caller byte-identical.
- `src/adapter/parent-agent.ts`: `bindActivation(agent, sessionId, origin)`; `activate` passes `"user"`, `activateSpawnedDispatcher` passes `"spawned"`. Nothing else branches on it; both surfaces still get the same eight tools (pinned in test).

**Tests (all green, offline):**
- `test/policy-assembler.test.ts` — 32 pass. New suite `spawned dispatcher policy variant (ticket 141)`, 5 cases: user text byte-identical to default; spawned text names the summoner + result route + todo trigger + delivery line; spawned text drops both false statements; both variants keep headings/order/shared doctrine and differ in exactly 3 lines; flag OFF stays empty for either origin.
- `test/spawn-dispatcher-activation.test.ts` — 18 pass. New: `the spawned origin reaches the policy text; the user-started text is untouched (ticket 141)` (both surfaces hold all eight tools); `a cold-resumed child is re-activated with the spawned wording (ticket 141)`.
- `test/restart-honesty.test.ts` — 18 pass, unchanged.
- Adjacent, also green: `test/spawn-dispatcher-tool.test.ts`, `test/spawn-dispatcher-host.test.ts`, `test/policy-peer-roster.test.ts`, `test/feature-flag.test.ts` (76 pass).

Files touched: `src/core/policy/prompts.ts`, `src/core/policy/assembler.ts`, `src/adapter/parent-agent.ts`, `test/policy-assembler.test.ts`, `test/spawn-dispatcher-activation.test.ts`. Nothing committed (lead commits). Byte-identity check output: `.scratch/testing/2026-10-22-ticket141-policy-slice/`.

The full differentiation design — whether to adopt option A/B/C/D, the peer-roster labelling, and whether `deliver_result` should stay on a child — **still awaits the owner**. Status stays `needs-triage`; labels untouched.
