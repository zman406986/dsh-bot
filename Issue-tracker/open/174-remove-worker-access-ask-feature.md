# 174 — Remove the worker access-ask feature entirely

**Status:** open
**Type:** task
**Labels:** ready-for-agent
**Blocked by:** nothing. Reverses an accepted ADR — see "Authority" below; the owner's ruling is recorded.
**Origin:** owner-directed, 2026-11-03. The owner asked what the reference does about access asks; the answer was "nothing", and the owner ruled: *"delete Access policy entirely"*, then confirmed *"Yes, cut the whole feature"*.
**Related:** ADR-0008 (the decision this reverses, new ADR-0033 records it), ticket 13 (the feature's origin), ticket 122 / ADR-0028 (the mid-task reply channel — **untouched**, it is a separate lane).

## Why

The reference has no worker access-ask channel at all. Verified by grep over the reference tree:

- No `request_access`, `requestAccess`, or access-relay name anywhere in `source/`. The only hits are unrelated generated proto files (dashboard, background composer).
- Its only "asking" copy is the opposite: `buildAntiAskQuestionUserRule` tells agents not to ask for help, details, feedback, or confirmations (`source/packages/agent/prompts/anti-ask-question-copy.ts`).
- Its one approval path is a retry flag on MCP calls (`requestSmartModeApproval`), not a worker relay.
- No access tool in `source/packages/agent/tools/core/subagent/`.

The reference's answer to a blocked worker is the host's own pin plus a plain report: dsh pins delegated children to `approval: 'never'` (`dsh-subagent/lib/types/child-agent.js:180-202`), the child's `subagent:delegation` runtime-context section states the limitation, and the worker reports it in its final answer.

So the whole relay is our invention, not a reference behavior. The owner ruled it out.

## Scope — what gets deleted

**Source (8 files, ~2,451 lines):**

| File | Lines | What |
|---|---|---|
| `src/core/access-relay.ts` | 397 | the relay, `matchTargetPattern`, `DEFAULT_ACCESS_TIMEOUT_MS` |
| `src/core/access-types.ts` | 127 | `AccessTicket`, `AccessDecision`, `ACCESS_CLASSES`, `AccessClass` |
| `src/adapter/access-prompt.ts` | 682 | the ask prompt, `UserQuestionsLike` |
| `src/adapter/worker-access-tool.ts` | 307 | the `request_access` tool |
| `src/adapter/dispatch-approval.ts` | 190 | approval mirror |
| `src/adapter/resolve-command.ts` | 218 | `/dispatcher-resolve` |
| `src/client/approval-feed.ts` | 133 | client ask feed |
| `src/client/approval-cards.ts` | 397 | client approval cards |

**Tests:** `test/access-prompt.test.ts` (1070), `test/access-relay.test.ts` (887) — delete. `test/approval-cards.test.ts`, `test/dispatch-approval.test.ts`, `test/resolve-command.test.ts`, `test/worker-ask-park.test.ts` — delete if they exist only for this feature, otherwise prune to their non-access cases.

**Prompt text:**

- `src/core/policy/prompts.ts` — delete `buildAccessPolicyBlock` + `buildAccessPolicyBlockEn` + `buildAccessPolicyBlockZh`.
- `src/core/policy/assembler.ts` — delete `assembleAccessSection` and its `lines.push(buildAccessPolicyBlock(language))` call site (`:536`); remove the `requests`/`resolved` access argument from `assembleWakeTurn`.
- `src/worker/prompt.ts` — delete the `## Asking for access` section (EN `:117-119`, ZH `:190-192`), remove `"## Asking for access"` from `WORKER_CONTRACT_HEADINGS` and `"## 申请访问"` from `WORKER_CONTRACT_HEADINGS_ZH`, and fix the `## Limits` line that lists "the access ask described below" as one of the worker's three channels.

**Wiring:**

- `src/plugin.ts` — the `request_access` registration block (`:999-1067`), the `accessRequestTimeoutMs` config field (`:91`, `:195`, `:821-832`).
- `src/core/wake-bus.ts` — the `worker-access-request` source constant and the branches that produce it (`:10,17,26,302,331,681`).
- `src/core/multitask.ts` — access relay construction and ticket plumbing.
- `src/core/roster-snapshot.ts` — the `pendingAsks` envelope field and its parse/validate (wire format v4 → v5).
- `src/index.ts`, `src/adapter/index.ts` — the export lists.
- `src/core/review-posture.ts` — it imports `matchTargetPattern` from the relay and `AccessClass` from types; rehome what survives or delete the dependent paths.
- `src/client/*` — `roster-store.ts` (`AccessClass`), `settings-card-store.ts` + `overlay.ts` (the `accessRequestTimeoutMs` settings row and its EN/ZH locale strings).

## What must NOT be deleted

- **The mid-task reply channel** (`reply_to_dispatcher`, ticket 122 / ADR-0028). Different lane, still live, not part of this feature.
- **The worker tool barrier** (`src/worker/tool-barrier.ts`). Unrelated.
- **The `subagent:delegation` host section.** It is the host's, and it is now the *only* statement of the access limit — the worker contract should lean on it, exactly as its header comment already says.
- **The dispatcher peer lane.** Unrelated.

## The worker contract after this cut

`## Limits` must stop promising an ask channel. It should say what the reference says: scope is fixed, you cannot widen it, so if the task needs more, report what was blocked and why in the final answer. `## Reporting` already carries the dead-end-reporting rule, so the honest-reporting half needs no new text.

Do **not** restate the host's `subagent:delegation` guarantee — see the contract header's standing rule.

## Requirements

- **R1** No `request_access` tool is registered anywhere; a test asserts its absence from the worker surface.
- **R2** No access text reaches either prompt; a test asserts the worker contract has no access section and the wake turn renders no access block.
- **R3** The worker contract still teaches the mid-task reply channel — it is the surviving worker→parent channel.
- **R4** EN and ZH faces stay line-for-line equal (`test/policy-zh-assets.test.ts` pins this).
- **R5** `npm test` 0 fail, `npm run typecheck` clean on both configs.
- **R6** Offline tests only. No network, no LLM, no live dsh.

## Acceptance criteria

- [ ] The 8 source files and 2 dedicated test files are gone; no import of them remains.
- [ ] `grep -rn "request_access" src/` returns zero hits.
- [ ] The worker contract's `## Limits` no longer promises an ask channel and still names the mid-task reply.
- [ ] The roster wire format bump is recorded and the client parses it.
- [ ] Full suite green; both tsconfigs clean.
- [ ] `npm run lint:docs` passes (issue index + ADR index regenerated).

## Notes

- **Authority:** this reverses ADR-0008 (accepted). The owner's dated ruling is the origin line above. ADR-0033 records the reversal and the reference evidence; ADR-0008 gets a `Superseded by ADR-0033` line in its status.
- Order matters: regenerate `open-issue-index.md` with `node tools/issue-index.mjs`, and `docs/adr/README.md` with `node tools/adr-index.mjs --fix` if that flag exists — both are checked by `lint:docs`.
- The client's approval pane is user-visible. Removing it means the settings card loses a field; check `test/client-settings-card.test.ts` and the locale dictionary.
