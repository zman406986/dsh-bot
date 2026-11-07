# 188 — RACOONS entry partial retention drops image blocks from mixed tool results

**Status:** resolved
**Labels:** ready-for-agent
**Priority:** P2
**Severity:** medium
**Ship blocker:** no — RACOONS is opt-in and off by default; live-provider frequency is unknown.

## Problem and impact

A native host tool result can contain both a text block and a non-text image attachment. RACOONS projects the result into text bytes for entry judgment, then an accepted partial-retention entry application rewinds and replaces the whole host tool-result content with one text block. The image block is therefore absent from subsequent active context even when only part of the text was selected for retention.

This is a concrete mixed-content replacement issue, not a claim that every image read is entry-eligible. It requires RACOONS to be enabled, an available/eligible ask route and a partial-shape answer. The supplied 422-byte case crosses the shipped 256 model floor, not the separate 512 default; it does not establish that the default eligibility path triggers. The current nested PTC image path defers the image as a separate user message, so this finding is specifically about native execution tool-result content.

The raw image event/attachment remains stored; the confirmed loss is from the replaced active-context projection and the text-only entry archive. This does not establish deletion of the underlying image file or event.

## Confirmed source and shipped-JavaScript evidence

- **The host can produce mixed content.** Installed [dsh-tool-fs imageReadContent:1735-1742](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js#L1735-L1742>) returns a text descriptor followed by an image attachment block for native image reads.
- **RACOONS judges only text bytes.** [port.ts:172-174](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/port.ts#L172-L174>) builds surface text by joining each block's `text` field, so a non-text image contributes no bytes. [planning.ts:309-316](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/core/engine/planning.ts#L309-L316>) passes only `input.result.bytes` into entry-shape planning; there is no archived image block to restore.
- **ENTRY checks that text projection, then rewrites the whole result.** [port.ts:465-486](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/port.ts#L465-L486>) compares the text projection to mirrored bytes, rewinds, and appends a tool result whose `message.content` is a single text block. There is no mixed-content refusal before the rewind. The mounted caller [adapter.ts:228-239](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/adapter.ts#L228-L239>) treats an applied engine result as landed. Shipped [lib/port.js:323-349](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/lib/port.js#L323-L349>) matches the source check and replacement.
- **This is not a missing global text-only fence.** The bulk revert path separately calls `textOnly(node)` at [revert.ts:277](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/revert.ts#L277>) and refuses unsupported content in [revert.ts:485-505](<C:/Users/TZ/Desktop/dsh-bot/vendor/racoons/adapter/revert.ts#L485-L505>). That guard is not called by ENTRY apply; this ticket must preserve it.

## Deterministic reproduction — supplied prior audit, not executed during filing

The supplied prior file-free probe exercised the actual `applyEntryShape` implementation through its memory-host seam. It is evidence for the entry write, not a live provider or full mounted conversation run.

1. Provide a landed tool-result node whose content blocks are `[text, image]`, while the RACOONS surface mirror contains only the text projection.
2. Apply a valid partial-shape answer with 422 text bytes (a valid 221-character path) under the 256 model-floor qualification. Do not treat this as evidence for the separate 512 default.
3. Inspect the apply result, append count, and resulting content block types.

Supplied prior-audit output: `status: applied`, two appends, and `[text, image] -> [text]`. The probe was not rerun for this filing. No live provider frequency or full host/model route frequency was measured.

## Acceptance criteria

- [ ] Preserve non-text blocks and their attachment references when partial text retention is applied to a mixed result; if ENTRY cannot preserve them, refuse the mixed result before any rewind or append so the landed result remains whole.
- [ ] Keep entry planning/archive data honest: text-only bytes must not stand in for or silently discard a non-text block. Do not claim that text-only archival can reconstruct an image.
- [ ] Keep the separate bulk revert `textOnly` protection intact; do not route ENTRY through a bulk-revert workaround that changes its semantics.
- [ ] Add a focused offline regression using mixed `[text, image]` content and a partial-shape answer. Assert preservation or refusal with zero host rewinds/appends, and retain a text-only control. Keep source and shipped JavaScript aligned.

## Duplicate check and related-ticket distinctions

Immediately before creation, prefix 188 was absent from open, deferred, resolved and cancelled, and a focused search found no equivalent partial-retention/image-block entry ticket in those states. The owner reserved 185-189; 188 is assigned to this finding.

[145](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/145-racoons-redo-latest-full-coverage.md>) and [148](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/148-racoons-resync-latest.md>) cover integration/resync. [150:74-82](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/150-racoons-record-only-semantics.md#L74-L82>) accepts entry checkpoint edits under record-only; it does not authorize dropping non-text blocks. [185](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/open/185-racoons-tool-finish-accepted-as-entry-answer.md>) concerns whether a tool-bearing response qualifies as an answer, not what the accepted ENTRY rewrite retains. [186](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/186-racoons-ask-iterator-cleanup.md>) and [189](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/189-racoons-entry-ask-drops-cancellation-signal.md>) cover iterator cleanup and cancellation wiring, respectively.

## Filing validation

Read the tracker rules, agent conventions and an existing ticket format. Static source/shipped-JavaScript reads and the supplied prior audit support this report. No probe, live provider call, test, build, agent or index generation was run for filing. Only this issue file is created; no source, tests, configuration, product documents, artifacts or index are changed.

## Comments

- 2026-11-07 — Filed as open / ready-for-agent / P2 / medium / nonblocker. The supplied prior probe was not executed again during filing.

## Resolution - 2026-11-08

Fixed in `4b66e2a`: partial retention now re-appends every non-text content block after the shaped text, so a mixed `[text, image]` result keeps its image; `test/racoons-port-partial.test.ts` passes 2/2.
