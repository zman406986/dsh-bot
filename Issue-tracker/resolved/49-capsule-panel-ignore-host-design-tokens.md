# 49 — The capsule/panel hardcode a dark palette instead of the host's shared `--dsw-*` design tokens, so the dispatcher UI cannot follow the light/dark theme

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** none
**Related:** 35 (capsule epic — the surfaces this touches), 38 (`CAPSULE_CSS`), 42 (capsule close-out), 27/28 (`ROSTER_PANEL_CSS`), 17 (always-on epic), 33 (close-out), 36 (seam research note this corrects)

## Symptom

Both always-on client surfaces paint themselves from a hardcoded dark palette.
`src/client/capsule.tsx:118-144` (`CAPSULE_CSS`) and `src/client/panel.tsx:69-105`
(`ROSTER_PANEL_CSS`) between them carry **23 raw colour literals** (`#161b22`,
`#30363d`, `#c9d1d9`, `#8b949e`, `#2f81f7`, `#2ea043`, `#f85149`, `#d29922`,
`#21262d`, `rgba(0,0,0,.4)`, `rgba(47,129,247,.55)`).

Consequence: on a **light** theme the chip and the expanded card render a dark
grey card with light text floating over a white application — and no amount of
theme switching changes it. The surface is visually a foreign object in half the
host's configurations.

## Root cause (CONFIRMED, cited)

Both blocks state the assumption in their header comments:

- `capsule.tsx:114` — "colors match the panel palette so no theme contract is assumed"
- `panel.tsx:66-67` — "colors are self-contained so no theme contract is assumed"

**The premise is false.** The host ships a large, published design-token layer
and every shipped surface consumes it:

- The token layers are defined in `dsh-client-ui-theme/lib/client.js:1052-1060`
  (`design-platform.css` + friends), split by scheme:
  - `body{--dsw-alias-…}` — the light alias layer
  - `body[data-ds-dark-theme]{…}` — the dark alias layer
  - plus a `:root`/static palette the alias layer references.
- Because the definitions sit on `body`, they are **inherited by every
  descendant** — including a `shell.overlay` entry. No service call, no
  subscription, and no boot-graph edge is needed to consume them: a plugin
  simply writes `var(--dsw-…)` and it resolves per scheme.
- Scale: **368 distinct `--dsw-*` tokens** are referenced across shipped client
  bundles; **79 `--dsw-alias-*` tokens** are defined per scheme.
- The host's own floating surfaces use exactly the tokens we should be using —
  e.g. `--dsw-specific-menu: var(--dsw-alias-bg-layer-3)` (`lib/client.js:1053`).
- The host's own CSS uses `color-mix(in srgb, var(--dsw-alias-bg-layer-1) 75%,
  transparent)` (`lib/client.js`), so `color-mix` over a token is an idiom the
  host itself ships, not a novel dependency.

Our own research note never caught this. `docs/research/dsh-plugin-ui-patterns.md:94`
(Finding 6) records theme only as *"a service + `theme/change` event consumed by
the layout"* — true, but it omits the token layer entirely, and the
implementation read that omission as "there is no theme contract". The
`theme` **service** (`ctx.theme`, `dsh-client-ui-theme/lib/types/client/index.d.ts:109-188`)
is for *owning* preferences and registering themes — it is **not** how a surface
becomes theme-correct. Surfaces become theme-correct by consuming the alias
tokens. (We correctly do not need the service, and we should not bind it; the
gap is the stylesheet layer, not the service.)

## Why this is the right thing to do now

Ticket 36's own lesson (`dsh-capsule-seams.md`, ADR-0013) is that the host
prescribes its seams rather than us improvising. The token layer is the same
kind of seam: shared, documented, and already the sole styling basis of every
neighbouring surface. Reusing it is both the smaller diff and the only way the
capsule stops being a foreign object.

## Requirements

1. Every colour in `CAPSULE_CSS` and `ROSTER_PANEL_CSS` resolves through a
   `--dsw-*` token. **No raw literals remain** (no `#hex`, no bare `rgb()/rgba()`;
   `color-mix()` over a token is allowed and preferred where translucency is
   meant).
2. Roles map semantically, not decoratively — the pairing is part of the ticket:
   | Role | Token |
   |---|---|
   | floating chip/card surface | `--dsw-alias-bg-layer-3` (the host's own menu/popover value) |
   | card elevation | `--dsw-elevation-panel` |
   | strong border / divider | `--dsw-alias-border-l3` / `--dsw-alias-border-l2` |
   | primary text | `--dsw-alias-label-primary` |
   | muted text + idle/stopped dot | `--dsw-alias-label-tertiary` |
   | accent — working dot, work ring | `--dsw-alias-state-business-primary` |
   | warn — starting dot, blocked marker | `--dsw-alias-state-warn-primary` |
   | success — done dot, landed marker, wake badge | `--dsw-alias-state-success-primary` |
   | error — failed dot, failed-send notice | `--dsw-alias-state-error-primary` |
   | button surface / hover | `--dsw-alias-interactive-bg-hover` |
3. **Do not** use `--dsw-alias-brand-primary` for the accent. Despite the name
   it is the high-contrast *label* colour (`neutral-bluish-1000` light /
   `neutral-bluish-50` dark, `lib/client.js:1053`) — using it for a status dot
   would paint a white dot on dark and a black dot on light. This is exactly the
   kind of near-miss the ticket exists to prevent, so it is called out.
4. The **existing `opacity`-based text hierarchy stays.** It is scheme-agnostic
   (alpha over a themed colour reads correctly in both) and rewriting it to
   `label-secondary`/`label-tertiary` would be a visual-density change this
   ticket has no evidence for. Colours change; type scale and density do not.
5. **Font sizes stay in px.** `--dsw-font-*` is the conversation-content scale
   and the host's own font-size *preference* is about chat content; a control
   surface is not conversation content. `font:inherit` already takes the host
   family. Recorded as a deliberate non-change.
6. The two header comments claiming "no theme contract is assumed" are replaced
   with the verified statement.
7. The sibling surfaces stay untouched: `overlay.ts` and `toolview-panel.tsx`
   carry no colour literals (`toolview-panel` reuses the panel classes), so the
   diff is exactly two files plus tests/docs.

## Acceptance criteria

- [x] (offline, gate) A pin fails if any raw colour literal reappears in either
      CSS block, and asserts the role mapping above; RED-verified against the
      pre-change palette.
      — **2026-09-19 (closeout batch): ticked from recorded evidence** — the
      2026-09-18 comment records `test/client-theme-tokens.test.ts` (15 cases /
      2 suites, in-tree, re-verified this batch) with the RED proof (reverting
      the chip background to `#161b22` fails 2 cases, including the raw-literal
      pin) and exact-set pins both directions.
- [x] (offline, gate) `npm test` 0 fail, `npm run typecheck` clean (both
      configs), `npm run build:client` OK — the animation/reduced-motion and
      namespace pins that already guard these blocks stay green.
      — **2026-09-19 (closeout batch): ticked from recorded evidence** —
      726 pass / 0 fail / 188 suites, typecheck clean on both configs,
      `build:client` OK, and the built bundle inspected (zero retired literals,
      `--dsw-alias-brand-primary` ×0).
- [x] (offline) `docs/research/dsh-plugin-ui-patterns.md` Finding 6 carries the
      token-layer finding with citations, so the next implementer does not
      re-derive "no theme contract" from its silence.
      — **2026-09-19 (closeout batch): ticked — verified present in-tree** at
      `docs/research/dsh-plugin-ui-patterns.md:95` (the 2026-09-18
      correction/addition: token layer, scale, the two traps, the pin pointer).
- [x] (live, ZERO LLM calls — ticket 33's pass) the chip and card follow the host
      theme: legible light **and** dark, on a real launcher/profile boot. — **2026-09-19
      live pass 2: both schemes on one profile boot; resolved token values recorded; see
      comment.**

## Notes

- Do **not** bind `ctx.theme`. The service owns preferences, registration, and
  `theme/change`; a read-only surface needs none of it. Binding it would add a
  boot-graph edge for nothing (the same reasoning ADR-0014 records for not
  declaring `settings`).
- Do **not** add hex fallbacks (`var(--dsw-x, #161b22)`). The tokens are defined
  on `body` in the shell's own base stylesheet, which is unconditionally present
  wherever the overlay can render; a fallback would only smuggle the rejected
  dark palette back into the bundle and defeat the pin.
- No new ADR is required: this is not a seam choice, it is adopting the seam the
  host already mandates for styling. ADR-0013's slot decision is untouched.
- Clean-room: token **names** are host API surface, equivalent to a documented
  prop; no reference-tree or reference-plugin styling was read for this change.

## Comments

### 2026-09-18 — implemented and verified offline (main @ this commit)

**Status:** implemented; one live AC open (the light/dark assertion belongs to
ticket 33's pass).

**What landed.** All 23 colour literals are gone from the client surfaces; both
stylesheet constants now resolve entirely through host tokens.

- `src/client/capsule.tsx` — `CAPSULE_CSS`: chip/card surface →
  `--dsw-alias-bg-layer-3` (the host's own `--dsw-specific-menu` value) with
  `--dsw-alias-border-l3` and `--dsw-alias-label-primary`; card elevation →
  `--dsw-elevation-panel`; dividers → `--dsw-alias-border-l2`; idle dot →
  `--dsw-alias-label-tertiary`; active dot → `--dsw-alias-state-business-primary`;
  error dot + failed-send notice → `--dsw-alias-state-error-primary`; wake badge →
  `--dsw-alias-state-success-primary`; activation button →
  `--dsw-alias-interactive-bg-hover` with a `--dsw-alias-label-tertiary` hover
  border.
- `src/client/panel.tsx` — `ROSTER_PANEL_CSS`: the five FSM dots →
  `state-business` (working) / `state-warn` (starting) / `state-success` (done) /
  `state-error` (failed) / `label-tertiary` (idle + stopped); the two markers →
  `state-warn` / `state-success`; the steer control → `border-l3` +
  `label-tertiary`; the working ring keeps its 55 % translucency as
  `color-mix(in srgb, var(--dsw-alias-state-business-primary) 55 %, transparent)`
  — the host's own idiom over a token.
- Both header comments' "no theme contract is assumed" claim is replaced with the
  verified statement and its citation.

**Pins (`test/client-theme-tokens.test.ts`, 15 cases / 2 suites).** Per surface:
no hex/`rgb()`/`hsl()` literal; every referenced token is in the `--dsw-` namespace
(`alias`/`elevation`); **no token carries a hex fallback**; `brand-primary` is never
used as an accent. Globally: the referenced token sets are pinned **exactly** (10
capsule / 6 panel), so drift in either direction fails. Plus role assertions naming
each declaration, and a structural assertion that the ring stays a `color-mix` over
the accent.

**RED-verified before GREEN.** Reverting just the chip background to `#161b22`
fails 2 cases — `capsule (CAPSULE_CSS): carries no raw colour literal`
(`ERR_ASSERTION`, message `hex literal`) and
`capsule: floating chip and card are layered surfaces with host elevation`.
Restoring returns the file green. The exact-set pin would additionally catch a
token *swap* (e.g. the `brand-primary` trap), which is why the set is asserted
rather than a count.

**Gates.** `npm test` **726 pass / 0 fail / 188 suites** (was 711 / 0 / 186 — +15
cases, +2 suites, no other file touched); `npm run typecheck` clean on both
configs; `npm run build:client` OK. The pre-existing guards on these two blocks
(namespacing, the ring being the only `animation:`, reduced-motion, the
hard-coded-literal sweep) all stay green — the migration changed colours only.
Built bundle (65,788 bytes) inspected directly: `--dsw-alias-bg-layer-3` ×2,
`--dsw-alias-state-business-primary` ×3, `--dsw-elevation-panel` ×1,
`--dsw-alias-brand-primary` ×0, and **zero** occurrences of any of the six
retired literals.

**Deliberate non-changes (per Requirements 4–5).** The `opacity`-based text
hierarchy and the px type sizes stay. `ctx.theme` is **not** bound — the layer is
inherited CSS, not a service, so binding it would add a boot-graph edge for
nothing. No hex fallbacks. `overlay.ts` and `toolview-panel.tsx` needed nothing
(no literals; the toolview panel reuses the panel classes), so the diff is two
source files.

**Research corrected.** `docs/research/dsh-plugin-ui-patterns.md` Finding 6's
theme bullet, which recorded the `ctx.theme` service and said nothing about the
token layer, now carries the token-layer finding with citations — that silence is
what produced the false premise in the first place. `docs/surfaces.md` gains a
theming section recording the mapping, both traps, and the non-changes.

**Not checked here:** the live AC. It needs a real launcher/profile boot in both
schemes and belongs to ticket 33's pass (it is a zero-LLM assertion — read the
chip/card computed colours, no session needed). No ticket file moved; this ticket
stays open on that AC.


### 2026-09-19 — re-based onto the wrapper-UI vehicle (ADR-0018; ticket 64)

The token-layer finding (368 `--dsw-*` tokens, per-scheme alias layers defined on `body`) is host
knowledge that survives any vehicle. The open live AC (chip/card legible in both schemes) is a
capsule-vehicle assertion — moot; the two-scheme check re-applies to whatever wrapper surfaces
consume host tokens. Kept open with this note; moot-closure proposed for the next triage.


### 2026-09-19 — live pass 2: live AC TICKED — chip and card follow the host theme in BOTH schemes on one profile boot (token values + screenshots)

Evidence root: `C:\Users\TZhen\Desktop\dsh-live-pass2-2026-09-19\` (throwaway `multitask`
profile, host 0.1.5-rc.1, commit `c56e69d` tree, zero LLM calls for this AC). Theme switched
through the host's own Settings → 通用设置 → 外观 (浅色/深色); `body[data-ds-dark-theme]`
observed toggling; the two `settings/mutate` calls this generated are `ui-theme` preference
writes made deliberately by the pass (throwaway profile), not plugin traffic.

Resolved values read on the wrapper surfaces (`theme-light-tokens.json`,
`theme-dark-tokens.json`, shots 04/06/07/08):

| Token | Light | Dark |
|---|---|---|
| `--dsw-alias-bg-layer-3` (chip/card surface) | `#fff` | `#353638` |
| `--dsw-alias-border-l3` | `#0000001f` | `#ffffff29` |
| `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-label-tertiary` | `#81858c` | `#adb2b8` |
| `--dsw-alias-state-business-primary` | `#4176e6` | `#679efe` |

Computed surfaces invert correctly with the scheme: capsule chip and launcher chip paint
`rgb(255,255,255)` bg / `rgb(15,17,21)` label in light and `rgb(53,54,56)` / `rgb(249,250,251)`
in dark — ~17:1 and ~13:1 contrast pairs, both legible; the dormant capsule card
(`multitask-dispatcher-capsule__card`) reads the same pairs (`shots/07-dark-card.png`,
`shots/08-light-card.png`). No raw literals observed on any wrapper surface.

Note per the 2026-09-19 re-base: the shell sidebar surface could not be read — the shell
`main` page cannot open on this boot (ticket 84, uninjected service reads throw). The AC's
own words ("the chip and card") are fully proven; the offline AC boxes 1–3 stay for the
implementer to tick from the 2026-09-18 offline comment's evidence.

### 2026-09-19 — CLOSED (closeout batch): all four ACs carry evidence

Offline boxes 1–3 ticked from the 2026-09-18 offline record; this batch re-verified the
underlying artifacts still in-tree (`test/client-theme-tokens.test.ts`; the research-note
correction at `docs/research/dsh-plugin-ui-patterns.md:95`). Live box 4 was already ticked
at pass 2: both schemes on one profile boot, resolved token values recorded
(`theme-light-tokens.json` / `theme-dark-tokens.json`, re-verified against the artifacts
this batch — the recorded values match byte-for-byte; ~17:1 light / ~13:1 dark pairs,
shots 06–08), zero LLM calls.

Vehicle note, recorded honestly: the capsule/panel blocks this ticket restyled were
retired at the 78 cutover (a44084a / 94e6127 / c437ee8). The live AC was proven on the
then-live surfaces before retirement, and the ticket's deliverable — no raw colour
literals, semantic `--dsw-*` mapping, exact-set pins against regression — is
vehicle-independent: the successor shell surfaces already follow it (ticket 81's approval
cards CSS is token-only), and the two-scheme legibility check re-applies there if ever
wanted. Status → resolved.
