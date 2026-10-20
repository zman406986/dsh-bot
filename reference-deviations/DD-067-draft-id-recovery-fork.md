# DD-067 — Draft identity, recovery slot & targeted clearing vs unconditional clear
- **Area:** composer drafts (A9)
- **Type:** missing-feature (mechanics layer)
- **Date:** 2026-09-23

## What the reference does
The reference composer-draft slice treats a draft as an identified, guarded object rather than a bare string. Every non-empty draft write creates a fresh draft id (a `crypto.randomUUID()` with a time/random fallback when crypto is unavailable) so each editing session of the draft is distinguishable from its predecessors. The send path never clears blindly: an identify step matches the composer's current content to the stored draft and returns its id, and a targeted clear taking the agent id and the draft id clears only if that exact id is still current — so a draft typed *after* the send was initiated is never destroyed by the send's completion. A content-based sibling, a match-based clear, covers clears where the caller holds the text rather than the id.

Separately, the store maintains a distinct recovery slot alongside the live draft. A recovery-promotion action promotes a parked recovery into the live draft only when the live draft is empty; otherwise the recovery stays parked, so an incoming recovery can never silently overwrite work in progress. A recovery-clearing action consumes the parked copy once handled. Emptying the composer is treated as clearing the live draft while the recovery slot survives untouched. Draft equality is deliberate: the draft-equality helper extends content equality with the reply-target id and the fork flag, so a reply-target or fork-flag change counts as a draft revision and creates a new id (and re-persists the draft). The mounted composer's editor clears via a generation bump on accepted send, rather than by directly zeroing shared state.

## What the current build does
The build's composer state is a single untyped `useState("")` string. On a resolved send it calls `setText("")` unconditionally inside the promise continuation — there is no draft identity, no generation counter, and no comparison against what the user may have typed since submission. Failure and no-channel outcomes keep the text (only `"sent"` clears), which matches the reference's keep-the-draft-on-failure behavior, but the build has none of the guarded-clearing machinery, no recovery slot, and no notion that reply-target or fork-flag changes alter draft identity. The build's composer has no reply/fork fields at all, so equality collapses to the raw string.

## The deviation
The reference's draft model is a small concurrency-safe protocol (mint an id → identify the draft → clear only that draft, plus a separate recovery slot), while the build reduces it to "clear the box when the promise resolves." In the reference, the targeted clear exists because sends are asynchronous and users keep typing; the unconditional clear can race — if the user typed during the in-flight send, `setText("")` destroys it. The recovery slot is a separate durability feature (park-then-promote, never clobbering live work). All of this is absent, not merely simplified.

## Verdict: ADAPT
The full machinery only earns its keep once drafts persist across mounts and accounts, which is DD-036's territory — that file owns the decision about how far draft persistence goes, and this deviation should be incorporated (if at all) as the mechanics layer on top of whatever DD-036 decides. Under ADR-0018 U-B (the exception excluding rich chat ergonomics; composer state is mount-scoped in the build, state dies with the mount), the identity/recovery layer is largely moot while the draft lives and dies in one component's `useState`. The one piece with standalone value is the targeted-clear idea: even in-memory, an accepted send should clear only the text it actually sent, not whatever the user has typed since — that is a small, cheap guard that can be adapted without adopting a full persistence layer. Recovery slots and reply/fork-aware identity should wait for, or be folded into, the DD-036 decision rather than landing piecemeal.

## Incorporation notes
- **Where it would live:** the in-memory targeted-clear guard belongs in `src/client/conversation.tsx`'s `Composer` (`submit` closure — capture the sent text and clear only if the current `text` still equals it); if DD-036 later rules for persistence, a draft-store module next to it would hold the id minting and the recovery slot, like the reference's state store.
- **Constraints:** keep U-B mount-scoping until DD-036 says otherwise; any id minting should prefer `crypto.randomUUID()` with a non-crypto fallback (the build's client may run in contexts without it); reply/fork-aware equality is unreachable until the build has reply targeting (DD-026 territory) — do not build dead fields; a race-guarded clear must compare against current state at resolution time, not at submit time.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — the in-memory targeted clear is a few lines in one closure; the full identity/recovery layer is M and only if DD-036 opens persistence.
- **Key reference anchors:**
  - `the reference tree's frontend/src/recovered/features/conversation/workspace/draft-state.ts` — draft-id mint (lines 111-116); identify + targeted clear (199-212); match-based clear (213-219); empty-draft clear preserving recovery (191-195); recovery promote-or-park (225-231); recovery clear (232-236).
  - `the reference tree's frontend/src/recovered/features/conversation/workspace/model.ts` — the draft-equality helper folding in the reply-target id and the fork flag (lines 61-65).
  - `the reference tree's frontend/src/recovered/features/conversation/workspace/composer.tsx` — editor cleared on accepted-send generation bump (lines 96-98).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/draft-state.ts`, `.../workspace/model.ts`, `.../workspace/composer.tsx`
- Build: `src/client/conversation.tsx` (composer `useState("")` at line 186; unconditional `setText("")` on `"sent"` at lines 195-199; keep-on-failure mapping at lines 136-147)
