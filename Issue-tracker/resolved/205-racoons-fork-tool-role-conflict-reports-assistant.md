# 205 — Racoons fork role-conflict reports an assistant turn for repeated tool turns

**Status:** resolved
**Labels:** ready-for-agent
**Severity:** P3 / low
**Ship blocker:** no
**Confirmation:** confirmed by a primary full-source reviewer and a separate independent validator

## Requirement

Document the existing repeated-role policy accurately: consecutive assistant turns and consecutive tool turns are refused; consecutive user turns are permitted. The fixed `role-conflict` diagnostic must describe every pair rejected by that branch truthfully. Preserve the existing policy and the adapter's missing-assistant refusal.

## Problem and evidence

The comment at [fork.ts:225–229](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/core/judge/fork.ts#L225-L229>) says only assistant turns must alternate. Its actual predicate rejects an equal consecutive role whenever the new role is not `user`. With the public role set `user | assistant | tool` at [assembly.ts:18–30](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/core/judge/assembly.ts#L18-L30>), both assistant/assistant and tool/tool enter this refusal branch.

The fixed message at [fork.ts:120–122](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/core/judge/fork.ts#L120-L122>) says: “A fork refuses a second assistant turn in a row; a user ask after a user turn is legal.” For tool/tool, this names an assistant turn that neither input contains. The shipped JavaScript repeats the comment and predicate at [fork.js:165–169](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/core/lib/judge/fork.js#L165-L169>) and the same fixed diagnostic at [fork.js:60](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/core/lib/judge/fork.js#L60>).

This is a public library surface: [core/index.ts:192–206](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/core/index.ts#L192-L206>) exports `seedFork`, `appendMessage`, `ForkError` and `forkErrorMessage`. The package's [exports:6–12](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/core/package.json#L6-L12>) point callers to the shipped [JavaScript export:51](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/core/lib/index.js#L51>) and [declaration exports:63–64](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/core/lib/index.d.ts#L63-L64>). The source contract also describes the policy in assistant/user terms at [fork.ts:16–23](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/core/judge/fork.ts#L16-L23>), copied into [fork.d.ts:16–23](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/core/lib/judge/fork.d.ts#L16-L23>).

## Why the rejection must remain

The adapter deliberately relies on refusing repeated tool turns when a request capture is missing the assistant response that made the later tool call. [entry-ask.ts:304–310](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/entry-ask.ts#L304-L310>) explains this fallback and the need for a surface seed. [entry-ask.ts:487–495](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/entry-ask.ts#L487-L495>) detects a prior, different tool result and throws its own specific `role-conflict` before appending. Permitting tool/tool would weaken an intentional guard; this ticket requests only accurate documentation and error wording.

## Static reproduction — not executed

Using the exported fork API, reason through this expression without a provider or adapter call:

~~~js
appendMessage(
  seedFork({ system: "s", tools: [], messages: [{ role: "tool", text: "a" }] }),
  { role: "tool", text: "b" },
);
~~~

The seeded last role and appended role are both `tool`. They compare equal and are not `user`, so the existing branch refuses with `ForkError` code `role-conflict` and the fixed message quoted above. Neither entry is an assistant. The refusal is expected; the assistant-specific explanation is inaccurate. This is a static, unexecuted reproduction, not a recorded runtime result.

## Impact and severity

LOW / P3, non-blocking: a caller of the shipped public fork API receives misleading documentation and a diagnostic that identifies the wrong role for tool/tool. This can misdirect investigation of a refused append. The host feature defaults off at [src/plugin.ts:123](<C:/Users/TZ/Desktop/dsh-bot/src/plugin.ts#L123>), while the exported library API and its generated peers are present in the shipped tree.

This finding establishes only documentation/error precision. It does not establish an actual provider failure, an acceptance bug, an LLM failure, an enabled integration defect or a release blocker. The adapter's missing-assistant refusal is intentional and must remain. Ship blocker: no.

## Acceptance criteria

- [ ] Describe all roles covered by the existing repeated-role policy: assistant/assistant and tool/tool are refused; user/user is permitted. Align the source contract, the branch comment and the public export commentary where they describe this policy.
- [ ] Make the fixed `role-conflict` diagnostic truthful for both rejected pairs, including tool/tool with no assistant entry. Preserve the error code and the rejection predicate.
- [ ] Preserve every accepted role pair: user/user and all pairs of different roles remain accepted, subject to the existing input and hash checks. Preserve assistant/assistant and tool/tool refusal; do not broaden acceptance to correct the wording.
- [ ] Preserve the adapter's missing-assistant fallback and the specific pre-append refusal linked above; do not fabricate a missing assistant turn or bypass the required surface seed.
- [ ] When fixed, keep the shipped JavaScript and declaration commentary consistent with their TypeScript source, including the published exports. Do not change the public signatures for this wording correction.
- [ ] Limit verification to focused local role-policy/diagnostic cases, preservation of the adapter's missing-assistant refusal and source/generated-peer consistency. Cover both refused pairs, the permitted user/user pair and the other accepted pairs; no provider or LLM call is needed to establish this wording issue.

## Duplicate and prefix checks

The primary reviewer and separate independent validator reported no existing ticket for this root after all-status searches for `fork`, `appendMessage`, `role-conflict`, second-assistant and repeated-tool wording. The ticket-writing pass repeated a broad `fork` search and a focused `appendMessage|role[-_ ]conflict|second[-_ ]assistant|repeated[-_ ]tool|fork\.(?:ts|js)|Only assistant turns` search across the tracker, covering `open`, `deferred`, `resolved` and `cancelled`. The focused search returned zero matches immediately before creation. Broad matches concern other fork/entry-ask behavior or unrelated host forks, not this comment/diagnostic root.

Immediately before writing on 2026-11-07, `Issue-tracker/*/205*.md` returned no paths across the status folders; a reserved-range check found no occupied prefix in 205–219. Selected 205 without overwriting or renumbering any existing ticket.

## Check limits

Evidence provenance is the supplied primary full-source review plus separate independent validation; this ticket-writing pass reread the exact cited source and generated-peer ranges and checked duplicate/prefix availability. The independent validation also found no directly relevant local test or ADR. The reproduction remains unexecuted. No tests, builds, live calls or runtime probes were run for this ticket. No implementation, other documentation, configuration, tests, index or generated artifact was edited. No reference-tree code was copied.

## Comments

- 2026-11-07 — Confirmed audit ticket recorded from the primary full-source review and separate independent validator, including the validator's explicit requirement to preserve both rejected pairs, every accepted pair, the error code and the adapter's missing-assistant refusal. Reread the cited short ranges and repeated focused duplicate and all-status numeric-prefix checks immediately before creation. LOW / P3; ship blocker: no. Ticket only; no fix or execution validation performed.

## Resolution - 2026-11-08

The role-conflict message now names both refused pairs and the legal user case; commit `0b22e84`; `test/racoons-fork-role.test.ts` 5/5.
