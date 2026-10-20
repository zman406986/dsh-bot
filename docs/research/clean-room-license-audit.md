# Research: clean-room / license audit (ticket 15, late milestone)

- Question: Does the shipped dsh multitask-dispatcher tree contain any reconstruction identifiers, codenames, file basenames, or borrowed prompt/tool copy — or any vendored reconstruction file?
- Scope: shipped product tree only — `src/`, `test/`, compiled `lib/`, `package.json`, `package-lock.json`, `tsconfig.json`, `README.md`. Explicitly **not** audited as product: the nested reference tree (`reference material-NOT LICENSE SAFE DONT COPY-grok bot/`, own `.git`, never committed into), `.scratch/` design drafts, `docs/research/` evidence notes (which may cite reference paths by design), `docs/diagrams/` (architecture diagrams of the reference runtime), and root policy docs (`AGENTS.md`, `PRD-dsh-multitask-dispatcher.md`, `CONTEXT.md`) that **name** forbidden terms as prohibition.
- Method: one-time check run late in the project (PRD §12 Legal QA / §13 M4 / §17 / S7). `rg` case-insensitive over the shipped tree; word-boundary and reconstruction-basename variants; manual review of every prompt/policy/tool-description asset; glossary trace against CONTEXT.md + PRD §16. Reference tree was **not opened** for this audit.
- Date: 2026-09-16

## Verdict

**Clean after one fix.** One shipped comment named the reconstruction codename; it was rewritten. After the fix and a rebuild, the shipped tree contains no reconstruction codenames as product identifiers, no reconstruction file basenames, no vendored reconstruction files, and no suspiciously reference-like prompt/tool copy. Prompt and tool-description assets read as independent new copy. Shipped identifiers trace to this project's glossary (CONTEXT.md) or the PRD §16 concept glossary.

## Commands run

Working directory: repo root. Excludes: `node_modules/`, `.git/`, the nested reference tree, `.scratch/`, and (where noted) compiled `lib/`.

```
# primary codename sweep (case-insensitive)
rg -n -i "sand" src test package.json package-lock.json tsconfig.json README.md CONTEXT.md AGENTS.md agent.md
rg -n -i "executor|MessageSubagent|SAND_MULTITASK" src test package.json package-lock.json tsconfig.json README.md CONTEXT.md AGENTS.md agent.md

# word-boundary / sand- variants (PCRE2)
rg -n -i --pcre2 "\bsand\b(?!\s*(box|boxes))|(?<!\w)sand[-_]" src test ...

# reconstruction file basenames (from PRD §17 + research evidence paths)
rg -n -i "subagent-runtime|run-scheduler|completion-revivals|turn-toolset|agent-adapters|system-prompt-assembly|host-runner-composition|task-client|roster-projection|send-turn-dispatch|shared-rooms|agent-messaging|box-exec|local-exec|background-work|sand-subagent|sand-agent" src test ...

# compiled output
rg -n -i "sand|executor|MessageSubagent|SAND_MULTITASK" lib
```

Also: `npm run build` + `npm run typecheck` + `npm test` after the fix (see below).

## What was searched

| Layer | Result |
|---|---|
| `src/**/*.ts` (all modules: core FSM/registry/steer/todo/wake/peer/access/policy/tools, worker agent-def/prompt/report/tool-barrier, adapter host/tools/wake-copy/durability/settings) | **1 finding, fixed** (see below). No other product identifier or string hit. |
| `test/**/*.test.ts` | Only hits are the **intentional** `FORBIDDEN_VOCAB` negative-test arrays in `policy-assembler.test.ts`, `report-clamp.test.ts`, `worker-agent-type.test.ts`. Those fixtures are the ongoing guard, not shipped product identifiers. |
| `lib/` (compiled) | Clean after rebuild (the one src comment had been preserved in emit). |
| `package.json` / lockfile / `tsconfig.json` / `README.md` | No hits. Package name `dsh-multitask-dispatcher` is ours. |
| Prompt / policy / tool-description assets under `src/core/policy/`, `src/worker/prompt.ts`, `src/adapter/wake-copy.ts`, `src/core/tools.ts`, `src/core/tool-results.ts`, `src/adapter/worker-access-tool.ts` | Manual read of every model-facing string. Independent voice ("dispatcher, not the workhorse", stream_key / ledger / silence-is-valid, Role→Autonomy→Limits→Final answer). No reference-like phrasing, no product-name leaks, no reconstruction tool names. |
| Reconstruction file basenames as `src/` module names | None. Shipped names (`wake-bus`, `steer-queue`, `worker-fsm`, `todo-reconciler`, `peer-inbox`, `multitask`, …) are independently chosen from the PRD/CONTEXT glossary. |
| Vendored reconstruction files anywhere under the product tree | None. The nested reference tree is present as a sibling folder with its own `.git` and is **not** imported, required, or copied into `src/`/`lib/`/`test/`. |
| Glossary traceability (CONTEXT.md + PRD §16) | Shipped public vocabulary is project vocabulary: Dispatcher, Worker, Peer agent, Steer, Wake, Delivery, Stream key, Multitask core, Multitask profile. Avoid-list terms from CONTEXT (orchestrator/engine, bot/teammate, subagent-as-Worker, parity, mode/setting) do not appear as shipped product names. First-party dsh API surface names (`subagents`, `Agent.followup`, `todo/write`) appear only as host-glue references — MIT host, not reconstruction. |

## Findings and fixes

### F1 — reconstruction codename in a shipped comment (fixed)

- **Where:** `src/adapter/wake-copy.ts` line 5 (file-header comment).
- **What:** the comment read `No Sand/reconstruction wording.` — the word `Sand` is a reconstruction codename (PRD §8 / §17 / AGENTS.md). AC treats comments as in-scope for the shipped-tree search.
- **Severity:** not a product identifier, not user-visible, not a copy of reference source — but it is a forbidden codename in shipped tree comments, so the ticket could not close on it.
- **Fix:** comment rewritten to `No reconstruction-tree wording.` No behavior change.
- **Rebuild:** `npm run build` so compiled `lib/adapter/wake-copy.js` / `.d.ts` match.
- **Re-run:** post-fix `rg -i "sand"` over `src/` and `lib/` no longer hits product files. Remaining `sand` hits are (a) the intentional test `FORBIDDEN_VOCAB` fixtures, (b) AGENTS.md policy text naming the prohibition, (c) the English word **sandbox** in `src/core/access-types.ts` ("a host the sandbox would not allow") — a generic technical term for host network isolation, not the codename; CONTEXT.md/PRD also use "sandbox" in the legitimate dsh sense.

### Non-findings (recorded so the next reader does not re-open the question)

- **Test `FORBIDDEN_VOCAB` arrays** (`sand`, `executor`, `MessageSubagent`, `SAND_MULTITASK_`): deliberate negative-test fixtures. They prove generated copy stays clean. Keep them.
- **AGENTS.md / PRD / CONTEXT.md**: policy and design docs that name forbidden terms in order to ban them. Not shipped product.
- **`docs/research/reference-behavior-notes.md`**: evidence paths cite reconstruction file names by design (plain-language behavior notes; never copy). Out of product scope.
- **`docs/diagrams/reference-agent-runtime.*`**: diagrams of the reference runtime, not shipped product code. Out of product scope.
- **`src/core/access-types.ts` "sandbox"**: legitimate English / dsh host term.
- **First-party dsh names** (`subagents`, `startContinuable`, `followup`, `todo/write`): MIT host API surface (see `docs/research/dsh-adapter-api-notes.md`), free to imitate. Not reconstruction identifiers.

## Prompt-asset review (new-copy rule)

Every model-facing asset was read end-to-end:

| Asset | File(s) | Assessment |
|---|---|---|
| Dispatcher session policy | `src/core/policy/prompts.ts` `buildDispatcherPolicySection` | New copy. Project voice, PRD §6.1 behavioral bullets, no jargon-to-user rule. |
| Standing rules / per-turn reminder | `buildStandingRulesBlock`, `assembleTurnReminder` | New copy. Short-turn / spawn / steer / todo / reconcile / silence. |
| Wake instructions | `buildWakeInstructionsBlock`, `assembleWakeTurn` | New copy. Ledger reconcile, stale/duplicate silence, lead-with-concrete. |
| Access policy block | `buildAccessPolicyBlock` | New copy (ticket 13). |
| Peer wake instructions | `buildPeerWakeInstructionsBlock` | New copy (ticket 14). Never presents peer text as the user. |
| Five dispatcher tool descriptions | `TOOL_DESCRIPTIONS` | New copy. `spawn_worker` / `check_workers` / `steer_worker` / `stop_worker` / `deliver_result`. |
| Tool result formatters | `src/core/tool-results.ts` (`formatSpawnAck`, `formatSteerNote`, `formatStopNote`, `formatCheckSummary`) | New copy. |
| Worker system prompt | `src/worker/prompt.ts` `buildWorkerSystemPrompt` | New copy. Role→Autonomy→Limits→Todo ledger→Work style→Final answer. No user channel. |
| Worker report placeholders | `src/worker/report.ts` | New copy. |
| Wake / peer cues | `src/adapter/wake-copy.ts` (`WAKE_CUE`, `PEER_WAKE_CUE`) | New copy. |
| Worker `request_access` description | `src/adapter/worker-access-tool.ts` | New copy. |

No accidental recalled phrase was found that required rewriting beyond F1's comment. Continuous guard already exists via the three `assertNewCopy` / `FORBIDDEN_VOCAB` tests.

## Glossary traceability

CONTEXT.md Language section + PRD §16 concept glossary are the source of truth. Shipped identifiers map as:

| Shipped name | Glossary source |
|---|---|
| Dispatcher (policy copy, tools) | PRD §16 "Dispatcher"; CONTEXT Multitask core |
| Worker, WorkerRecord, WorkerStatus, spawn_worker, steer_worker, stop_worker | PRD §16 "Blank worker" / "Steer"; CONTEXT "Worker" |
| stream_key | PRD §16 "Stream key" |
| SteerQueue, steer | PRD §16 "Steer" |
| Wake bus, WAKE_CUE, wake turn | PRD §16 "Wake" |
| Todo ledger, delivered, markDelivered | PRD §16 "Delivery"; AGENTS.md Todos rule |
| Peer agent / peer inbox / peer wake | ADR-0002; CONTEXT "Peer agent" |
| Multitask / multitask-dispatcher plugin name | CONTEXT "Multitask core" / "Multitask profile" |
| Access relay / request_access | Ticket 13 vocabulary (new) |

No shipped identifier is a reconstruction codename or a CONTEXT avoid-list synonym.

## Exit criteria (issue 15 AC)

- [x] One late grep of the shipped tree for reconstruction identifiers (`sand`, `executor`, `MessageSubagent`, `SAND_MULTITASK_*`, reconstruction file basenames) — source, prompts, tool descriptions, comments, fixtures, user-visible strings.
- [x] Prompt assets reviewed as new copy; the one codename comment rewritten, not lightly edited around.
- [x] Every shipped identifier traces to this project's glossary or is independently chosen.
- [x] This dated note records command, search set, findings, and result.
- [x] Finding fixed in the shipped tree; grep re-run; build + typecheck + tests green.
- [x] No reconstruction file is imported, vendored, or transliterated in the deliverable.

## Residual risk

- This audit is **static text matching**, not a semantic similarity pass against reference sources. The reference tree was deliberately not opened during the audit, so a paraphrased-but-not-literal borrow would not be caught by these greps. Mitigation already in place: new-copy discipline during implementation, `assertNewCopy` unit tests, and PRD §10 "write new copy" rule. A deeper similarity review would be a **new** legal task, not this ticket.
- The nested reference tree remains on disk beside the product (AGENTS.md reference-folder policy). It is not imported and has its own `.git`; it must never be committed into this repo or shipped.
