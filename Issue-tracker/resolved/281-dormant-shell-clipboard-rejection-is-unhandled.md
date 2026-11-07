# 281 — Dormant shell clipboard rejection is unhandled

**Status:** resolved
**Labels:** needs-triage
**Severity:** P3/low
**Ship blocker:** NO
**Scope:** DORMANT/UNMOUNTED retained source

> **DORMANT/UNMOUNTED retained source only.** This is a conditional source-contract defect, not an ordinary live incident. The default composition creates no shell mounts and has no live mirror producer. ADR-0024's native-dsh posture remains in force; this ticket requires no UI reactivation. The retained export does not by itself establish a supported public extension or mounting promise.

## Problem and source contract

The retained shell's [src/client/shell.tsx:203–212](../../src/client/shell.tsx#L203-L212) contract accepts a clipboard writer returning `void | Promise<void>` and explicitly says that the absent-host browser fallback contains failure, leaves the session ID readable, and never shows fake success.

The default fallback violates that containment contract for asynchronous failure. [src/client/shell.tsx:215–222](../../src/client/shell.tsx#L215-L222) calls `void navigator.clipboard?.writeText(text)` inside a synchronous `try/catch`. That catches a synchronous throw, but it does not observe a later rejection of the returned promise. The default function also returns `void`, so its rejected browser promise is already discarded before the row callback returns.

Separately, the row callback [src/client/shell.tsx:414–418](../../src/client/shell.tsx#L414-L418) invokes the selected injected/default writer with `void` and has no surrounding failure handler. An injected writer's synchronous throw escapes that click callback, and an injected writer's rejected promise is unobserved there too. These are the same copy-boundary containment gap; the default fallback's contract violation is independently sufficient to establish this ticket.

## Current evidence and reachability limits

All anchors below were re-read in the current tree on 2026-11-07.

| Evidence | Source conclusion |
| --- | --- |
| [src/client/shell.tsx:203–222](../../src/client/shell.tsx#L203-L222) | The writer seam allows synchronous or asynchronous completion; the fallback promises contained failure but discards `writeText`'s promise inside synchronous `try/catch`. |
| [src/client/shell.tsx:305–315](../../src/client/shell.tsx#L305-L315) | Only a dispatcher row gets the copy button; `onClick` directly calls `onCopyId`. The session ID is literal button text and its title, with no success state. |
| [src/client/shell.tsx:321–343](../../src/client/shell.tsx#L321-L343) | `ShellSeatBoundary` handles seat render failures. It supplies no clipboard event/promise containment. |
| [src/client/shell.tsx:362–366](../../src/client/shell.tsx#L362-L366) and [414–418](../../src/client/shell.tsx#L414-L418) | `createDispatcherShell` retains the composition seam with default `hosts = {}`; its copy callback discards the selected writer's outcome without a guard. |
| [src/client/index.ts:214–232](../../src/client/index.ts#L214-L232) | The roster/mirror path is not composed, the mirror feed has no live channel/producer, and `const mounts: ShellPageMount[] = []` creates no default shell mounts. |
| [src/client/index.ts:685–710](../../src/client/index.ts#L685-L710) | The retained shell-host composition supplies panel, conversation, selection, and onboarding seats, but no clipboard writer or wrapper that could contain this rejection. |
| [ADR-0024:13–18](../../docs/adr/0024-native-dsh-posture-restored-by-human-ruling.md#L13-L18) | The floating surface is withdrawn and shell machinery is retained, unmounted. This ticket preserves that posture and does not request a mount or mirror transport. |

## Conditional trigger and impact

1. An explicit composition mounts a shell created by `createDispatcherShell` and supplies enough state for a dispatcher row to appear. This is a precondition outside the default composition, not a claimed supported public extension workflow.
2. The copy-session-ID button is clicked without an injected clipboard writer, selecting the default browser fallback.
3. The browser's `navigator.clipboard.writeText` returns a promise that rejects for any reason.
4. Neither the default writer nor the copy callback observes that rejection, so it escapes this source boundary as an unhandled promise rejection.

If a writer is injected instead, its synchronous throw or rejected promise also escapes the copy boundary. No injected-writer assumption is needed for the default fallback finding.

The conditional impact is an escaped clipboard failure, not a proven shell crash or a current default-UI incident. The session ID remains readable as button text/title by source inspection, and the existing path shows no fake success. No browser permission outcome, shell crash, failure frequency, or live reachability was observed or measured.

## Duplicate check before filing

On 2026-11-07, the `281` filename prefix was checked in all four status directories (`open/`, `deferred/`, `resolved/`, `cancelled/`) and directly in the tracker root; all were free before creation. Content deduplication covered all four status directories and every root Markdown file: [tracker conventions](../issue-tracker.md), [ownership note](../ownership-note-2026-10-22.md), and the generated [open issue index](../open-issue-index.md), read only. Search terms covered `clipboard`, `copyToClipboard`, `defaultCopyToClipboard`, `onCopyId`, `writeText`, and copy-ID/copy-session-ID spellings.

No matching defect was found in `open/`, `deferred/`, `cancelled/`, or the tracker-root files. The resolved matches were reviewed as follows:

- [Ticket 70:52–55](../resolved/70-peer-tier-dispatcher-to-dispatcher-messaging.md#L52-L55) records the contained browser fallback and readable-ID/no-fake-success contract as delivered work. It does not already report the rejected-promise defect; it substantiates the contract this retained implementation fails.
- [Ticket 104:83–125](../resolved/104-stale-dispatcher-mirror-after-restart.md#L83-L125) closes stale mirror/kill-row behavior as obsolete after its surface, producer, and stop affordance were removed. Its dormant-surface limits apply here, but its mechanism and symptom are distinct from clipboard rejection containment.
- [Ticket 102:26](../resolved/102-summon-and-kill-dispatchers-from-the-floating-window.md#L26) and [51–52](../resolved/102-summon-and-kill-dispatchers-from-the-floating-window.md#L51-L52) concern summon/kill discoverability and command transport; copy-ID mentions describe historical layout changes, not rejection handling.
- [Ticket 33:393–400](../resolved/33-closeout-cleanroom-lqa-provenance-review-merge.md#L393-L400) reviews shell wording, including the copy-ID label; it does not report this failure path.

## Minimum acceptance

- [ ] A rejected default browser clipboard write is contained at the retained copy boundary; the promise is actually observed rather than merely covered by synchronous `try/catch`.
- [ ] An injected writer that throws synchronously or returns a rejected promise is also contained at that copy boundary.
- [ ] The session ID stays readable in the copy affordance and its title when copying is unavailable or fails; no fake success is shown.
- [ ] ADR-0024's native-dsh posture is preserved: no UI reactivation, new shell mount, mirror producer/transport, or public extension promise is required by this ticket.

## Validation and limits

This filing used source reads, tracker searches, and filename-prefix checks only to validate the finding and its scope. It contains no executed browser/runtime probe and makes no reproduction claim. No tests, builds, or browser actions were run. No source, tests, configuration, existing documentation, or generated index was edited; this ticket is the only file created or changed by this filing.

The default fallback violation is independently confirmed by the declared containment contract and the discarded browser promise. Injected-writer escape is additional evidence of the same boundary gap, not another candidate or ticket. P3/low and ship blocker NO reflect the retained, unmounted scope and absent default mirror producer.

## Comments

### 2026-11-07 — ticket-writing pass

Filed from independently confirmed finding 621028. Rechecked the current source anchors and all four status-prefix/content checks plus tracker-root deduplication before creating this previously unused 281 path. No existing ticket was overwritten, renamed, or moved. This is a ticket-writing stage only; implementation and executed validation remain outside this pass.

## Resolution - 2026-11-08

commit e6da578; a private containCopy helper catches sync throws and promise rejections in both the browser fallback and the shell row callback, with no fake success; the same file 16/16.
