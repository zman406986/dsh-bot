# 80 — Wrapper conversation surface: text-only chat + composer (ADR-0020 slice 4)

**Status:** open
**Labels:** needs-triage
**Blocked by:** 77 (skeleton), 78 staging mount (a surface needs a page to render into)
**Related:** ADR-0020 (inventory rows: streaming, delivery, composer), `wrapper-vehicle-seams.md` Finding 2 (`ctx.conversation`), exceptions U-B/U-C/U-E/A4, 75 (session/event tool-call path)

## What to do

- [ ] **Open verification first:** the conversation *history replay* face a custom surface reads
      to paint past turns (`dsh-client-ui-conversation` internals were not isolated in the
      vehicle pass — `wrapper-vehicle-seams.md` Finding 2 honest gap). Read-only pass on the
      installed host; record with file:line; no fantasy seams.
- [ ] Text-only conversation view for the selected dispatcher session: user + assistant turns,
      streaming-in-place assistant text, tool activity as collapsible per-tool rows (re-host
      ticket 24's toolview content). U-B excludes rich ergonomics; U-C excludes timeline cards;
      U-E keeps delivery text-only.
- [ ] Composer: sends through the host sink (`ctx.conversation.send` — direct sends, no send
      journal, A4); steer is the same composer (no special steer UI); no stop affordance
      anywhere (area 7 conformity).
- [ ] Worker results render as ordinary assistant messages (delivery = the dispatcher speaking).

## Constraints

- Offline: view models, turn-model reduction from session/event-shaped payloads, composer
  disable/enable states. Live streaming behavior waits for the live lane.
