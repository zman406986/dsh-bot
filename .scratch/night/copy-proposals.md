# Copy proposals for ticket 287 — eight wording fixes

**Status:** proposal only — nothing in the product tree was edited; no tests, build, or live session was run.
**Source:** `Issue-tracker/open/287-adapted-copy-follow-ups.md`, from the 2026-11-08 copy review (`docs/research/no-verbatim-copy-review-2026-11-08.md`).
**Line numbers:** the current working tree at `cc69118`. Several numbers in 287 are from the reviewed blob (`3d08313`) and have moved; the lines below are the current ones. The main drifts: `deliver_result`'s `todo_id` is at `src/core/tools.ts:1314` (287 says 1207), `spawn_worker`'s "todo entry" at `:933` (287 says 843), the test note is at `test/dispatcher-tools.test.ts:796` (287 says 633), and the steer command is under `src/adapter/`, not `src/client/`.
**Voice:** each proposal is a minimal edit to the existing line — the existing sentence stays, only the defective clause changes. The replacement wording is taken from how the product already names the same thing elsewhere.

**Read this first:** F1 is the false channel claim, and it is the only item that changes what the copy tells the model the channel is. F8 is a choice between two existing words. The other six are corrections with one obvious reading.

## F1 — the team-leader wake says to use a send that does not exist

**Where:** `src/core/policy/prompts.ts:555` (EN), `:584` (ZH)

Current — EN, `:555`:
```text
3. Report back to whoever gave you the task order. `message_agent` to the dispatcher that summoned you, addressed to the session id on the "Summoning dispatcher session id" line of your handoff prompt; use the user-facing send if the user directly ordered something from you.
```

Proposed — EN, `:555`:
```text
3. Report back to whoever gave you the task order. `message_agent` to the dispatcher that summoned you, addressed to the session id on the "Summoning dispatcher session id" line of your handoff prompt; if the user directly ordered something from you, state the result in your reply to the user — that reply is the channel they read.
```

Current — ZH, `:584`:
```text
3. 向交给你这项任务的人回报。用 `message_agent` 发给召唤你的那个调度器，地址用你交接提示开头那一行给出的会话 id；如果是用户直接向你下的令，就用面向用户的发送。
```

Proposed — ZH, `:584`:
```text
3. 向交给你这项任务的人回报。用 `message_agent` 发给召唤你的那个调度器，地址用你交接提示开头那一行给出的会话 id；如果是用户直接向你下的令，就在给用户的回复里说明结果——用户读到的就是这条回复。
```

F3 edits the address clause of this same line; the combined version is under F3.

**Why:** the step tells the team leader to use a user-facing send, but the live registration passes no `deliverToUser` (`src/plugin.ts:1496-1499`, with its dependency block at `:1402-1434`) and ADR-0009:12 records that the send stays unwired, so the instruction names a channel the build does not have — while the chief-of-staff step at `:534` already says the reply is the channel the user reads, and the `spawn_dispatcher` description says a team leader "answers its own user directly" (`:127`).

**Your call — meaning change.** This is the one item where the words change what the step points at: the reply replaces the send. If the reply is the channel, the proposal mirrors the chief-of-staff line at `:534`. If a user-facing send is intended and will be built, decline F1 and the copy waits for it; declining leaves the sentence describing a channel the build still does not have.

**Scope note:** the same phrase appears as a prohibition in the peer and worker-reply steps (`:629`, `:658`, `:721`, `:739`, `:752`, `:765`); 287 scopes F1 to the two positive instructions, so F1 does not change those prohibitions.

## F2 — the ZH peer step points at parentheses that are usually absent

**Where:** `src/core/policy/prompts.ts:658`

Current — ZH, `:658`:
```text
4. 如果之后必须回复同伴，用 `message_agent` 按发送者的会话 id 发送（见上方发送者名字旁边的括号）——绝不要用面向用户的发送。
```

Proposed — ZH, `:658`:
```text
4. 如果之后必须回复同伴，用 `message_agent` 按上方显示的发送者的会话 id 发送——绝不要用面向用户的发送。
```

**Why:** the renderer prints `### name (id)` only when the sender's name differs from its session id, so a dispatcher sender appears as a bare `### <id>` with no parentheses (`src/core/policy/assembler.ts:489-496`), and the ZH sentence points at something that is usually not there — the EN face was already corrected to "shown above" at `:629`.

**Meaning:** unchanged — same address, accurate pointer.

## F3 — the ZH faces never quote the handoff label

**Where:** `src/core/policy/prompts.ts:373`, `:584`, `:764` (the three ZH references to the line that carries the summoning dispatcher's session id)

Site 1 — `:373`, current:
```text
- 你不召唤其他调度器。如果这项工作需要的团队比你现在多，就向召唤你的那个调度器回报需要什么——它的会话 id 写在你的交接提示里——由它去召唤。
```

Site 1 — `:373`, proposed:
```text
- 你不召唤其他调度器。如果这项工作需要的团队比你现在多，就向召唤你的那个调度器回报需要什么——它的会话 id 写在你的交接提示里标着“Summoning dispatcher session id”的那一行上——由它去召唤。
```

Site 2 — `:584`, current:
```text
3. 向交给你这项任务的人回报。用 `message_agent` 发给召唤你的那个调度器，地址用你交接提示开头那一行给出的会话 id；如果是用户直接向你下的令，就用面向用户的发送。
```

Site 2 — `:584`, proposed (label only):
```text
3. 向交给你这项任务的人回报。用 `message_agent` 发给召唤你的那个调度器，地址用你交接提示里标着“Summoning dispatcher session id”的那一行给出的会话 id；如果是用户直接向你下的令，就用面向用户的发送。
```

Site 3 — `:764`, current:
```text
4. 如果它改变了召唤你的那个调度器在等的结果，就用 `message_agent` 向上回报，地址用你交接提示开头那一行给出的会话 id——用日常的话，不要提背后的运行细节，也不要转述工作者。否则就沉默地结束回合。
```

Site 3 — `:764`, proposed:
```text
4. 如果它改变了召唤你的那个调度器在等的结果，就用 `message_agent` 向上回报，地址用你交接提示里标着“Summoning dispatcher session id”的那一行给出的会话 id——用日常的话，不要提背后的运行细节，也不要转述工作者。否则就沉默地结束回合。
```

**Why:** the handoff line is emitted as the fixed English label whatever the policy language (`prompts.ts:84-91`, prepended at `src/adapter/cordis-dsh-host.ts:4664-4666`), so the ZH copy can name the exact string the model should look for instead of paraphrasing it.

**Meaning:** unchanged — it points at the same line, precisely. The English label is deliberate: that is how the line is written.

**If F1 and F3 are both ticked, `:584` reads:**
```text
3. 向交给你这项任务的人回报。用 `message_agent` 发给召唤你的那个调度器，地址用你交接提示里标着“Summoning dispatcher session id”的那一行给出的会话 id；如果是用户直接向你下的令，就在给用户的回复里说明结果——用户读到的就是这条回复。
```

## F4 — the same `todo_id` is a "Ledger entry" in `deliver_result`

**Where:** `src/core/tools.ts:1314` (`deliver_result`'s `todo_id` parameter). The same parameter is called "todo entry" in `spawn_worker` at `:933`.

Current, `:1314`:
```text
Ledger entry to mark completed once this result is recorded for the user.
```

Proposed, `:1314`:
```text
Todo entry to mark completed once this result is recorded for the user.
```

**Why:** `todo_id` is the same todo object in both tools, and the 2026-10-28 pass normalized this surface from ledger to todo; calling it a "Ledger entry" here makes the model look for a second kind of record that does not exist.

**Meaning:** unchanged — same parameter, one noun.

## F5 — the delivery card is written to the dispatcher, not the user

**Where:** `src/client/overlay.ts:198` (EN), `:528` (ZH)

Current — EN, `:198`:
```text
Result recorded — say it in your reply
```

Proposed — EN, `:198`:
```text
Result recorded — it arrives in the reply
```

Current — ZH, `:528`:
```text
结果已记录——请在你的回复中告知用户
```

Proposed — ZH, `:528`:
```text
结果已记录——会以回复送达
```

**Why:** this is the sentence the user sees on the `deliver_result` row, but it tells the dispatcher what to do — the ZH face even calls the reader 用户 in the third person — while results reach the user as replies (`src/client/toolviews.ts:939-941`; the onboarding copy already says results arrive as replies at `overlay.ts:397` and `:691`).

**Meaning:** unchanged — same fact, addressed to the reader instead of the model.

## F6 — a steer looks the same before and after it is accepted

**Where:** `src/client/overlay.ts:187-188` (EN), `:519-520` (ZH)

Current — EN: `:187` and `:188` both read `"Steering {subject}"`.

Proposed — EN: `:187` stays `"Steering {subject}"`; `:188` becomes `"Steer queued for {subject}"`.

Current — ZH: `:519` and `:520` both read `"正在调整 {subject}"`.

Proposed — ZH: `:519` stays `"正在调整 {subject}"`; `:520` becomes `"已为 {subject} 排队纠偏"`.

**Why:** the row prints the same sentence before and after the steer is accepted, so the card never shows that the correction was queued, while spawn, stop and message each have a distinct pending and done line (`src/client/toolviews.ts:782-785`).

**Meaning:** unchanged — "queued" is what the sent state means, and it mirrors the command's own success line (`src/adapter/steer-command.ts:42`, `:105`).

## F7 — the ZH priority fact goes back to the adjective

**Where:** `src/client/overlay.ts:495`

Current: `"toolview.fact.priority": "优先"`
Proposed: `"toolview.fact.priority": "优先级"`

The EN value at `:161` stays `"priority"`.

**Why:** the 2026-10-28 pass chose 优先级 as the word for priority, and the peer notice already uses 优先级 (`src/core/policy/assembler.ts:504`), so this key puts the old adjective back beside the corrected form.

**Meaning:** unchanged — same fact, same condition, dictionary form.

## F8 — two ZH words for one steer

**Where:** `src/adapter/steer-command.ts:103` (the command description)

Current, `:103`:
```text
向正在运行的工作者发送中途指示。最新的指示生效。
```

Proposed, `:103`:
```text
向正在运行的工作者发送纠偏。最新的纠偏生效。
```

**Why:** the same ZH face calls the action 纠偏 in its success line (`:105`) and its not-dispatcher refusal (`:108`), and the rest of the UI uses 纠偏 (`src/client/overlay.ts:579`), so the help text and the result name what the user did with two different words.

**Meaning:** shade only — the action is the same; the word for it changes.

**Your call — which word wins.** The proposal keeps 纠偏, the dictionary term recorded in ticket 153 and used by the roster button and the model-facing policy. If you prefer 中途指示 (closer to the EN command's "mid-run instruction"), decline the `:103` change and the fix moves to `:105` and `:108` instead. Either way the face ends up with one word; say which one is the product's.

## Tick what you approve

Unticked means not approved. If you want different words, write them beside the line and they go in as your text.

- [ ] **F1** — team-leader wake: the reply is the channel, not "the user-facing send" (`prompts.ts:555`, `:584`) — *your call: tick only if the reply is the channel*
- [ ] **F2** — ZH peer step 4: the id shown above, no parentheses (`prompts.ts:658`)
- [ ] **F3** — ZH handoff references quote `Summoning dispatcher session id` (`prompts.ts:373`, `:584`, `:764`; shares `:584` with F1)
- [ ] **F4** — `deliver_result` says "Todo entry" (`tools.ts:1314`)
- [ ] **F5** — delivery card says the result arrives in the reply (`overlay.ts:198`, `:528`)
- [ ] **F6** — an accepted steer reads "Steer queued for …" / 已为…排队纠偏 (`overlay.ts:188`, `:520`)
- [ ] **F7** — the ZH priority fact is 优先级 (`overlay.ts:495`)
- [ ] **F8** — one ZH word for steer: 纠偏 (`steer-command.ts:103`) — *your call: or write 中途指示 beside it*

Applying the ticked items — the copy edits and the tests that pin the affected strings — is a separate task; nothing in this document has been applied.
