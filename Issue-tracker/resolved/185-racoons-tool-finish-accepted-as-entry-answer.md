# 185 — RACOONS accepts a tool-calls finish as an answered entry decision

**Status:** resolved
**Labels:** ready-for-agent
**Priority:** P2
**Severity:** medium
**Ship blocker:** no — RACOONS is opt-in and off by default; the live frequency of mixed text/tool-call replies is unknown.

## Problem and contract

The shared RACOONS ask helper promises: “A reply is text or nothing: a tool call, an empty stream, a cap and a dead socket are all typed refusals” ([llm-ask.ts:179–180](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/llm-ask.ts#L179-L180>)). Its implementation ignores tool-call chunks and accepts nonempty text when the finish kind is `tool-calls`. The entry caller then parses that text as a completed decision without checking the finish kind.

A provider reply containing valid `{"forgetall":"summary"}` text alongside a tool call can therefore become `status: 'answered'` / `action: 'forgetall'`. The mounted caller sends answered outcomes to its entry-application path. This treats a tool-bearing, nonfinal response as an authorized entry decision, contrary to the helper's explicit contract. Refusing the response must leave the already-landed result whole through the existing refusal path.

## Confirmed source and shipped-JavaScript evidence

- **Tool calls are not recognized as refusals.** [llm-ask.ts:263–301](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/llm-ask.ts#L263-L301>) handles text, usage and finish chunks only; `tool-call-delta` chunks fall through. At [280–300](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/llm-ask.ts#L280-L300>), it records the finish kind, rejects `error`/`aborted`, `max-tokens` and empty text, then returns `answered`. A `tool-calls` finish with nonempty text passes. [Shipped llm-ask.js:187–222](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/lib/llm-ask.js#L187-L222>) matches.
- **The entry parser trusts the answered status.** [entry-ask.ts:537–550](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/entry-ask.ts#L537-L550>) checks only for a refusal before passing `first.text` to `readAnswer`; it never checks `first.finish`. Valid `forgetall` text returns an answered entry outcome. [Shipped entry-ask.js:357–370](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/lib/entry-ask.js#L357-L370>) matches.
- **The mounted caller applies answered outcomes.** [plugin.ts:1887–1937](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/plugin.ts#L1887-L1937>) calls `askEntry`, leaves the landed result whole on refusal, and otherwise appends the exchange and calls `applyEntryAnswer`. It has no independent finish-kind guard. [Shipped plugin.js:1373–1422](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/lib/plugin.js#L1373-L1422>) matches. This application consequence is established by source; the supplied probe observed the entry outcome, not a mounted transcript rewrite.

## Reachable trigger and limits

The root [flag:123](<C:/Users/TZ/Desktop/dsh-bot/src/plugin.ts#L123>) defaults `racoonsEnabled` to false. Explicitly setting it to true activates the [mount:2077–2086](<C:/Users/TZ/Desktop/dsh-bot/src/plugin.ts#L2077-L2086>). The adapter reads the host LLM service at [racoons-mount.ts:216–225](<C:/Users/TZ/Desktop/dsh-bot/src/adapter/racoons-mount.ts#L216-L225>), exposes it at [270–272](<C:/Users/TZ/Desktop/dsh-bot/src/adapter/racoons-mount.ts#L270-L272>), and the [vendor mount:2564–2573](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/plugin.ts#L2564-L2573>) consumes it. The [pre-step listener:2657–2666](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/plugin.ts#L2657-L2666>) reaches `runStep` and [runEntryAsks:2173](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/plugin.ts#L2173>).

With an askable landed result, usable ledger/fork and configured route, the entry ask retains main's tool schemas: [postLandingWire:1656–1686](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/plugin.ts#L1656-L1686>) carries `captured.wire.tools` into the surface seed, [sendOnce:432–441](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/entry-ask.ts#L432-L441>) passes `fork.tools` to the helper, and [askWire:193–207](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/llm-ask.ts#L193-L207>) forwards a nonempty tool list. A provider can thus return a tool-bearing response on this real entry path; it is not limited to a helper invoked with an impossible request.

No tool call was executed by the supplied probe, and no worker barrier bypass was demonstrated. The confirmed defect is answer acceptance. Live provider frequency, a live mounted context rewrite from this response, and broader data-loss or authorization consequences were not measured.

## Deterministic reproduction — supplied prior audit, not executed during filing

The original audit ran one file-free, offline probe against the actual shipped JavaScript entry ask, exiting with code `0`. Independent validation checked the explicit helper contract and reachable mounted path before filing. The ticket author re-read the cited source and shipped-JavaScript ranges; the probe was not rerun, and no new code execution is evidence for this filing.

Reproduce the deterministic case as follows; these are instructions, not a newly executed probe:

1. Import `askEntry` from the shipped entry module linked above. Supply nonempty provider/model names, a nonempty landed UTF-8 result and a valid wire seed containing exactly one tool schema. Use a seed ending in the assistant turn preceding that result, so the normal fork appends the landed result and entry ask. Keep the default entry variant.
2. Supply a fake LLM service whose `stream(request)` records `requestedTools = request.tools.length` and returns an async iterator. It must yield, in this exact order, a `text-delta` with `text: '{"forgetall":"summary"}'`, a schema-valid `tool-call-delta` requesting the retained tool, then `{ type: 'finish', reason: { kind: 'tool-calls' } }`. Return no other text and perform no tool execution.
3. Await `askEntry` and inspect `outcome.status`, `outcome.answer.action` and the outgoing tool count. No network, live provider timing or arithmetic correction is required for this valid `forgetall` answer.

Supplied prior-audit observed fields:

~~~json
{"status":"answered","action":"forgetall","requestedTools":1}
~~~

`requestedTools` counts tool schemas advertised in the outgoing request, not executed tools. Expected: a typed refusal, with no entry decision accepted or applied from this mixed response, despite its syntactically valid adjacent text.

## Acceptance criteria

- [ ] Fail closed on answer acceptance: a tool-call chunk or a `tool-calls` finish yields a typed refusal for this tool-bearing/nonfinal response, regardless of valid adjacent decision text. The entry caller must not turn it into an answered `forgetall` decision.
- [ ] The mounted entry path handles that refusal through its existing refusal behavior: the landed result stays whole and no answered exchange or entry application is produced from the rejected response.
- [ ] A clean text-only response containing the same valid decision, followed by a normal `stop` finish, remains accepted. Preserve the existing error/aborted, truncation and empty-text refusals.
- [ ] Add a minimal offline regression for the exact mixed-response case through the shared helper and entry caller, plus the clean-text control. Keep source and shipped JavaScript behavior aligned through the repository's normal implementation workflow. No such test or build was run for this ticket-only filing.

Iterator closing/draining and cancellation propagation are outside this acceptance scope; they are separate findings 186 and 189.

## Duplicate check and related-ticket distinctions

The original audit and independent validator checked all four states. Filing repeated relevant content searches in `open`, `deferred`, `resolved` and `cancelled`, finding no exact duplicate of mixed tool-call/nonfinal finish acceptance. Prefix 185 was unused in each folder immediately before creation. The parent reserved 185–189; 185 is assigned to this finding.

- [145](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/145-racoons-redo-latest-full-coverage.md>) and [148](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/148-racoons-resync-latest.md>) cover integration/resync. [150:74–82](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/150-racoons-record-only-semantics.md#L74-L82>) accepts the entry checkpoint applying even under record-only. This ticket preserves that accepted semantics and concerns which response qualifies as an answer.
- [186](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/186-racoons-ask-iterator-cleanup.md>) covers iterator cleanup after finish; reserved finding 189 concerns the entry caller's missing host cancellation wire. Neither is part of this answer-acceptance fix.
- [182](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/182-workflow-bypasses-worker-leaf-tool-barrier.md>) and [200](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/open/200-worker-composition-failure-keeps-unrestricted-worker-live.md>) concern worker capability barriers and different failure mechanisms. This ticket does not claim tool execution or a barrier bypass.

## Comments

- 2026-11-07 — Filed as open / ready-for-agent / P2 medium, explicitly not a ship blocker. Read [tracker rules](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/issue-tracker.md>), [agent conventions](<C:/Users/TZ/Desktop/dsh-bot/agent.md>) and an existing ticket format. Static citation/duplicate checks and read-only Git inspection only; supplied prior-audit probe explicitly not executed during filing. No agents, probes, tests, builds or index generation launched; only this ticket is created.

## Resolution - 2026-11-08

An entry reply that carries a tool call is refused with a typed reason mapped to the existing stream-error code; commit `e6bf3e4`; `test/racoons-llm-ask.test.ts` 9/9.
