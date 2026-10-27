# No-verbatim-copy review 2026-10-28 (ticket 154 — second recorded pass)

- Question: does the copy added since the 2026-09-19 pass contain any **verbatim reproduction** of the reference reconstruction's prompts, tool strings, identifiers, or protocol artifacts?
- Supersedes-as-evidence, not as record: `docs/research/no-verbatim-copy-review-2026-09-19.md` (ticket 33 close-out) stays untouched. This file is the pass that covers tickets 116–152, whose copy the earlier pass could not see.
- Governing rule: unchanged — adapted copying is permitted; verbatim reproduction is not. ADR-0018 voided the S7 identifier grep as a *gate*; this review replaces it as a quality check, and the residual risk stays human-accepted.
- Scope: OUR shipped tree only — `src/`, `test/`, `client/`, `lib/`, `scripts/`, `package.json`, root `README.md`. The reference tree was **not opened**; the comparison basis is entirely `docs/research/*.md`.
- Window: everything added after `439404b`, i.e. tickets 116–152 (peer messaging, bounded await, mitosis, peer roster, spawn variants, reply lane, raid/racoons surface). ZH faces landed in ticket 153 and are in scope too.
- Run: `.scratch/testing/2026-10-28-154-copy-review/scope.md` (the 80-row inventory) and `review.md` (the per-row verdict table), both collected at `7fe25dd`; the baseline tree for the verdicts is `a8cc5d0`, and this record's fixes ride the ticket-154 branch on top of `37358e7`.

## Method (same as 2026-09-19, re-run)

1. **Comparison basis.** Every quotation in `docs/research/*.md` was extracted (455 fragments of ≥3 words) and substring-matched against the copy files. 13 hits, all traced:
   - 8 are research notes quoting **our own shipped lines** (`2026-10-22-reference-nested-dispatcher-prompts.md` describes our policy by quoting it; `clean-room-license-audit.md` quotes our voice; `dispatcher-peer-memory-indicators-design-2026-10-18.md` quotes our peer heading). Not reference text.
   - 1 is `Give it a complete, standalone prompt: it does not see this conversation` (`dsh-extension-surface.md:39`) — a **host** (MIT) subagent-tool description. `CONTEXT.md` explicitly permits reading and imitating the host tree. Provenance: host, not reference.
   - 2 are `do not retry` inside a different sentence in `worker/prompt.ts`; the note that records the phrase (`segmented-compaction-design-2026-10-19.md:514`) is about a third-party paper.
   - 2 are our own protocol vocabulary quoted back by later notes.
2. **Search battery** over `src/ test/ client/ lib/ scripts/ package.json README.md` (case-insensitive; `vendor/racoons/**` excluded as vendored third-party):

   | Probe set | Result |
   |---|---|
   | `\bsand\b`, `MessageSubagent`, `SAND_MULTITASK`, `SandSubagent`, `buildSand`, `SAND_SUBAGENT`, `grok` | **0 product hits.** Only the four deliberate `FORBIDDEN_VOCAB` fixtures (`composition-polish`, `report-clamp`, `worker-agent-type`, `policy-assembler` tests). |
   | Reconstruction basenames (`subagent-runtime`, `run-scheduler`, `completion-revivals`, `turn-toolset`, `system-prompt-assembly`, `sand-subagent-management`, `sand-auto-review`, `cloud-meta-agent`, `subagents_pb`) | **0 hits.** |
   | Reference protocol tokens (`agent_gone`, `no_runner`, `session_unavailable`, `max_redrives`, `QUIET_REVIVAL`) | **0 hits.** |
   | Tempting borrows (`fork yourself`, `root-cause it yourself`, `Hand off the problem`, `just created you`, `should generally be trusted`, multitask enter/stay/exit phrasing) | **0 hits.** One incidental `no longer exists` in a code comment (`src/client/onboarding.ts:47`) and one test comment — ordinary English, unrelated. |
3. **Naming independence** for the four names new in this window:

   | Name | In-repo provenance |
   |---|---|
   | `message_agent` | PRD:148 (2026-10-18, ADR-0025); ticket 116 |
   | `await_agent` | PRD:149; ticket 117 |
   | `spawn_dispatcher` | PRD:150; ADR-0025; ticket 118 |
   | `reply_to_dispatcher` | CONTEXT.md:36 (Mid-task reply); ADR-0028; ticket 122 |

   None of the four appears in any note as a reference-side name; the reference has no equivalent path (the 2026-10-22 nested-dispatcher note records that its children cannot spawn).
4. **Prompt-phrase probes** for the four phrases the inventory flagged:
   - `generation-N team leader` → owner ruling 2026-10-23, recorded verbatim in `Issue-tracker/resolved/141-...`. In-repo authorship.
   - `Other agents — not the user` → our own `PEER_WAKE_SECTION_HEADINGS[0]` convention (tickets 14/121, ADR-0027).
   - `peer inbox` → ADR-0002 + CONTEXT "Peer agent" / "peer inbox"; the research note quotes our heading, not the reverse.
   - `Summon another dispatcher` → ADR-0025's summon/mitosis vocabulary.
   - `entry checkpoint`, `record-only` → **racoons library** terms (`vendor/racoons/adapter/lib/entry-ask.js`, the `RacoonsEnforcement` type). Vendor vocabulary, not reference.

## Result

**PASS on the method's own question — no verbatim reproduction found.** Zero codename, basename, or protocol-token hits outside the deliberate guard fixtures; zero hits against every reference artifact the notes record; the only long-phrase overlap with any note is a **host (MIT)** tool description, which the glossary permits, plus our own lines quoted back by later research.

Per-row arithmetic over the 80 rows (~103 discrete EN strings over 8 copy files plus `README.md`): **72 clean + 8 fixed in this ticket**. Meaning and register hold on every row after the fixes; no row needed a new ticket.

## Fixes (8, all copy-only, no behaviour change)

| # | File | Change | Why it is not a meaning change |
|---|---|---|---|
| 1 | `src/client/overlay.ts` | ZH `toolview.field.priority`: "优先" → "优先级" | Same field; ZH now reads as the noun the row prints. |
| 2 | `src/core/tools.ts` | `spawn_worker` `todo_id` description: "ledger entry" → "todo entry" | Same object; matches the param name, the refusal copy, and the standing rules. |
| 3 | `README.md` | Usage step 4: "to leave the mode" → "to leave the dispatcher" | No dispatcher mode exists (ADR-0018); the dispatcher does. |
| 4 | `src/core/policy/prompts.ts` | `spawn_worker` description, EN and ZH: "ledger entry"/"账本条目" → "todo entry"/"待办条目" | Same object as #2, same faces kept in parity. |
| 5 | `src/core/policy/prompts.ts` | `await_agent` description, EN and ZH: the `released` clause now names the user-message cause (`tool-results.ts` `formatAwaitNote` already does) | Adds the cause the wire actually carries; the "worker keeps running" promise is unchanged. |
| 6 | `src/core/policy/prompts.ts` | Access-policy line, EN and ZH: "answer each ask in your reply" → names the two real paths (the access prompt, `/dispatcher-resolve`) and says the answer never comes from reply text | Ticket 132 option 2, carried one step further: no reply-text channel exists, and now the copy says so. Timeout-deny default unchanged. |
| 7 | `src/adapter/wake-copy.ts` | `RESUME_WAKE_CUE` / `_ZH`: dropped "from your peer inbox" | The cue is also the dormant-worker payload, and a worker has no peer inbox. The sentence is now true for both readers; "arrives as the next turn" is what both paths do. |
| 8 | `README.md` | Racoons coverage line: now "every session in the process — the dispatcher, its workers, and plain chats alike" | The mount has no session filter (`racoons-mount.ts` header, `plugin.ts` mount comment); the old sentence understated it. |

## Rulings recorded here (agent rulings 2026-10-28, subject to owner reversal)

1. **`RESUME_WAKE_CUE` wording** — one cue serves two readers, so it names no lane rather than splitting a worker-face cue. Owner may prefer a split cue; reverting is a two-string edit.
2. **README racoons coverage** — state the actual coverage (every session) rather than narrowing the README to the dispatcher and its workers. Owner may prefer to confirm the narrower claim as deliberate; that is a one-sentence revert.

## Scope notes

- Covered: ticket 153's ZH faces for the policy section, the eight tool descriptions, the worker contract, and the wake/resume/peer cues; ticket 155's roster labels.
- Out of scope by design: `test/` fixtures, comments, identifiers, `vendor/racoons/**` (vendored third-party), and the reference tree itself.
- `src/core/tool-results.ts` and the `tools.ts` parameter descriptions remain EN-only — ticket 153's remaining gap, not a copy-review finding.

## Verdict

**PASS.** No verbatim text, identifier, or protocol artifact from the reference appears in the shipped tree. The 8 findings were all adapted-copy quality issues (term drift, one meaning gap, one false channel claim, one over-narrow user-facing claim); every one is fixed in the ticket-154 branch.

## Residual risk

Same as the 2026-09-19 record and unchanged: this is literal text matching plus provenance tracing, not semantic similarity against the reference tree (deliberately not opened). A paraphrased-but-not-literal borrow cannot be caught here. The human-accepted risk under the 2026-09-18 ADR-0018 ruling stands; this is a quality record, not a legal clearance.
