# 166 — A summoned dispatcher addresses the user directly, like any other dispatcher

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** nothing. Copy only; no behaviour change.
**Origin:** owner ruling 2026-10-29 (in-session): "its the same as any other dispatcher"
**Related:** ADR-0032 (this answers its open question 1; recorded as a dated note on its Status line), ADR-0025 decision 6 and its open question 2, tickets 118 (the spawn note), 119 (the mitosis policy line), 141, 157 (the session shape this follows from), 163 / 164 / 165 (other lanes; untouched here).

## Problem

ADR-0032 settled that a summoned dispatcher is a new top-level session, and left open who it may address. The shipped copy still answers that question the old way: it "cannot talk to the user, so its work reaches the user only through you."

The owner ruled on 2026-10-29: **"its the same as any other dispatcher"**. A summoned dispatcher *is* a dispatcher. In its own session it addresses the user directly, exactly as every dispatcher does — its own chat, its own sidebar row, its own user. The claim is therefore false, and false as written: it is not a limitation of the host, it is a statement about what the peer is.

What stays true, and stays in the text: it is a peer with the same tools and policy, its own ledger and inbox; it is not awaitable; its answers arrive later as their own message. Only the stated reason changes. It does not report through its summoner because it is mute; it answers its summoner because the summoner asked it something, and independently it answers its own user in its own chat.

Why it matters beyond accuracy: the old line tells a dispatcher that its summoned peer's work "reaches the user only through you", which reads as a licence to treat that peer as a mouthpiece — relay its output, or withhold it. With the ruling, the peer owns its own user; what comes back to the summoner is a reply to a question.

## Sites

| Site | Current false claim |
|---|---|
| `src/core/policy/prompts.ts:102` | EN `spawn_dispatcher` description: "it cannot talk to the user, so its work reaches the user only through you" |
| `src/core/policy/prompts.ts:129` | ZH `spawn_dispatcher` description: "它不能和用户说话，所以它的工作只能经由你到达用户" |
| `src/core/policy/prompts.ts:301` | EN `## How you work` peer bullet |
| `src/core/policy/prompts.ts:353` | ZH `## 你的工作方式` peer bullet |
| `src/core/tool-results.ts:150` | `formatSpawnDispatcherNote` spawn success note |

Test pins that move with the change:

| Site | What it pins |
|---|---|
| `test/policy-assembler.test.ts:116` | the needle `cannot talk to the user` — ambiguous: it passes on the worker-leaf line, so it silently covered the peer claim too |
| `test/policy-assembler.test.ts:271-277` | the EN policy sha256 pin; this is an intentional copy change, so the pin moves with it |
| `test/policy-assembler.test.ts:499-520` | the exact retired sentence, and a title that names the "user-channel gap" |
| `test/spawn-dispatcher-tool.test.ts:183-185` | `cannot talk to the user` in the note, with a comment citing ADR-0025 decision 6 |

## Acceptance

- [ ] No production text says a summoned dispatcher cannot talk to the user, or that its work reaches the user only through its summoner.
- [ ] All five sites in the first table say the positive thing instead: it is a dispatcher like any other, with its own chat and its own user, whom it answers directly; it reports back because it was asked.
- [ ] EN and ZH stay one-to-one: same bullets, same order, same line shape. ZH reads as native Chinese in the register of its neighbours, not as a translation.
- [ ] The true neighbours are unchanged: peer / same tools / same policy / own ledger and inbox; not awaitable; answers arrive later on their own; "You are the user's main assistant in this chat" (EN `:284`, ZH `:339`).
- [ ] Worker copy is untouched — workers still cannot talk to the user (`src/core/policy/prompts.ts:295`, ZH `:350`). Workers stay leaves.
- [ ] `test/policy-assembler.test.ts` pins the new meaning and no longer pins the retired sentence; the EN sha256 pin is re-pinned with a dated comment saying why.
- [ ] `test/spawn-dispatcher-tool.test.ts` asserts the note's new claim, and the stale ADR-0025-decision-6 comment goes.
- [ ] `test/policy-assembler.test.ts:116` becomes unambiguous — it pins the worker-leaf line it was standing in for.
- [ ] `npx tsc -p tsconfig.json --noEmit` exits 0; `test/policy-assembler.test.ts`, `test/spawn-dispatcher-tool.test.ts`, `test/policy-zh-assets.test.ts`, `test/policy-peer-roster.test.ts` pass; `node tools/issue-index.mjs && node tools/doc-lint.mjs` clean.
- [ ] ADR-0032's Status line carries a dated 2026-10-29 note with the ruling's exact words. No ADR body edited, nothing renumbered.

## Constraints

- Do not add a `"spawned"` policy variant, and do not reintroduce `origin` as a discriminator. One policy for every dispatcher is the whole point of the ruling.
- Do not re-open ADR-0032's settled decisions (top-level creation, no parent/origin/depth, no spawn cap, cold resume in v1, one uniform policy). This ticket changes one claim about who a summoned dispatcher may address, nothing else.
- Do not touch ticket 163's four implementation defects, ticket 165's stale bound prose, or ticket 164's `"spawned"` literal.
- Do not invent a named concept. The ruling is "same as any other dispatcher"; say it in the words the file already uses.
- Keep out of ticket 157's diff. No behaviour change: the note and the prompts are text only.
- ADR bodies are never edited; the dated note on the Status line is the only permitted ADR edit.
