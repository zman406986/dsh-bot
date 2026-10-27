# 146 — Upgrade the dispatcher glyph to a small animated bot portrait

**Status:** claimed
**Labels:** ready-for-agent
**Origin:** owner 2026-10-27: "dispatcher glyph needs to be upgraded to a small animated bot portrait, something like what dshbot or grokbot does".
**Blocked by:** nothing — the dated owner instruction (2026-10-27) rules the glyph's visual form, which ADR-0024's rider had left TBD.
**Related:** ADR-0024 (rider — exactly one additive glyph seat), ADR-0018 (Decision 6 "C13" identity-avatar boundary and exception B9 adapted-copy rule), DD-084, DD-111 (reference-deviations/), docs/surfaces.md (glyph seat + idle-only limit).

## Problem

Today the dispatcher mark is a single unicode text character: `DISPATCHER_GLYPH = "◆"` (U+25C6)
at `src/client/session-kind.tsx:87`. `KindGlyphBody` (`src/client/session-kind.tsx:211-233`) renders
it as a plain text node inside a span carrying class `multitask-dispatcher-kind-glyph`,
`data-session-kind`, `role="img"`, `aria-label` and `title`. No CSS exists for that class; the span
just inherits the host's `--dsh-alias-label-*` text colour (`docs/surfaces.md:220`).

The seat is the single licensed additive registration: slot `sidebar.session.row.leading`, entry id
`multitask-dispatcher-kind`, order 20, injected once at `src/client/index.ts:307-316`. The host
renders that entry in a 16×20 px cell and only on idle rows (host
`dsh-client-ui-workspace/lib/client.js:2260-2306`; `docs/surfaces.md:259` — the cell unmounts while
the session runs).

"grokbot" in the owner's sentence is the reference tree `reference material-NOT LICENSE SAFE DONT
COPY-grok bot/` (Grok Bot 0.18 reconstruction). Its agent avatar is an inline SVG character (shapes,
eyes, mouth) animated by a `requestAnimationFrame` transform loop with a `prefers-reduced-motion`
bail: `frontend/src/recovered/features/onboarding/signed-in/character.tsx:244-325`, the `MOTION`
table at `:234-240`, and `frontend/src/recovered/features/conversation/workspace/agent-avatar.tsx`
(`SIZE_PX` xs = 16, `:39`). "dshbot" does not exist anywhere in this repo.

Two in-repo precedents make the mechanism cheap and testable: the host itself ships an animated
inline-SVG mark (HeroFish: SMIL path morph plus `@keyframes` gated on hover and reduced motion, in
`dsh-client-ui-conversation`), and our own roster panel already ships
`@keyframes multitask-dispatcher-roster-ring` with a `prefers-reduced-motion` override
(`src/client/panel.tsx:91-93`, asserted structurally in `test/client-roster-panel.test.ts:527-534`).

The owner wants the dispatcher mark upgraded to a small animated bot portrait in that spirit.

## What to do

- [x] In `src/client/session-kind.tsx`, replace the dispatcher glyph's text body with an inline SVG
  bot portrait that fits the 16×20 cell (draw at ~16×16): an original, simple bot head/face (for
  example a rounded head and two eyes), colours only via `currentColor` / existing `--dsw-alias-*` /
  `--dsh-elevation-*` tokens. Keep the wrapper semantics unchanged: class
  `multitask-dispatcher-kind-glyph`, `data-session-kind`, `role="img"`, `aria-label`, `title`. Keep
  the SVG markup authored in-repo (JSX), not a copied path table.
- [x] Animate it via CSS `@keyframes` emitted from the component through a `<style>` element — the
  repo idiom (`src/client/panel.tsx:303` style injection; roster-ring keyframes at
  `src/client/panel.tsx:91-93`) — with subtle motion (for example a gentle bob and/or blink). It
  MUST include a `prefers-reduced-motion: reduce` override that disables the animation and leaves
  the static portrait.
- [x] Keep exactly one additive registration and its seat unchanged (`src/client/index.ts:307-316`);
  no new slots or entries (ADR-0024 rider).
- [x] Leave the worker glyph `"↳"` (`WORKER_GLYPH`) and the normal-kind `null` rendering untouched;
  leave kind-resolution logic untouched (`src/client/session-kind.tsx:145-157`).
- [x] Update the pins in `test/client-session-kind.test.ts`: the dispatcher assertions at `:334`
  (`mark.textContent === DISPATCHER_GLYPH`) and `:336` (`DISPATCHER_GLYPH.length === 1`) break with
  an SVG body — rewrite them to assert the new structure (an `svg` inside the mark,
  `data-session-kind="dispatcher"`, `aria-label`), and keep the `:219` "dispatcher and worker marks
  differ" assertion meaningful. Add structural animation assertions (keyframes rule present,
  reduced-motion override present) following `test/client-roster-panel.test.ts:527-534`; jsdom cannot
  run animations, so assert structure only.
- [x] Build and gates in one grouped run: `npm run build:client`, `npm run check:client` (must be
  byte-fresh), `npm run typecheck`, `npm test`, `npm run lint:docs` (there is no `npm run lint`
  script; `lint:docs` is the docs gate).

## Constraints

- **LICENSE.** The reference tree is **NOT LICENSE SAFE**. Adapted or independent design only
  (ADR-0018 B9): do NOT copy the reference's shape paths, `MOTION`/state tables, gradients or
  component structure verbatim. The bot portrait must be independently authored from scratch.
  Nothing may be committed into the reference tree.
- **C13 boundary** (ADR-0018 Decision 6 — no agent-identity roster, avatars or identity panes): this
  stays a session-kind MARK in the one licensed glyph seat. No per-agent persona system, no uploaded
  photos, no activity-state catalog, no identity pane.
- **Idle-only seat.** The cell does not mount while a session runs; the animation plays on idle rows
  only. Do not chase the running state.
- **No static assets of any kind.** The host client-module route serves only `client.js`, client
  chunks and maps (dsh-client-modules `CLIENT_CHUNK` regex) — no PNG/GIF/Lottie/JSON files; everything
  is inline SVG plus CSS. No data-URI image assets either.
- **Theme contract pins** (`test/client-theme-tokens.test.ts`): namespaced `multitask-dispatcher-`
  classes only; no raw colour literals (hex/rgb/hsl); never `--dsw-alias-brand-primary` as an accent;
  colour via `currentColor` and tokens only.
- **Offline only.** No live dsh / LLM / browser run is needed (client-only change, PRD §4 S8).

### ADR notes

- Owner instruction 2026-10-27 is the level-1 human ruling that resolves the ADR-0024 rider's
  "the glyph's visual distinction is TBD — this rider invents no design": the design is now ruled
  (a small animated bot portrait). The rider's other limits hold unchanged (one additive
  registration; glyph scope and nothing else).
- **DD-084** (avatars / generated personas) verdict was ASK-HUMAN. For this seat the human has now
  answered: an animated bot portrait on the dispatcher kind mark is wanted. Scope stays a session-kind
  mark, not an identity-avatar system, so C13 is not crossed.
- **DD-111**'s DO-NOT-INCORPORATE verdict covers the reference's animated character under the
  onboarding scene layer's no-animation rule. This ticket's animation lives on a different surface
  (the glyph), and this ticket is its own recorded decision — it inherits no exception and grants
  none.
- **Mechanism choice recorded:** CSS `@keyframes` on an inline SVG (the repo's own panel plus the
  host HeroFish idiom), NOT the reference's `requestAnimationFrame` loop — least code, structurally
  testable in jsdom, idiomatic reduced-motion handling.

## DoD

- [x] Dispatcher rows render the animated SVG bot portrait; it renders static under
  `prefers-reduced-motion: reduce`; worker rows and normal rows unchanged.
- [x] `test/client-session-kind.test.ts` rewritten and green together with the client-theme-tokens
  pins; `npm run check:client` byte-fresh after `npm run build:client`; grouped gates (typecheck,
  full offline suite, `lint:docs`) green.
- [x] No verbatim asset or code copied from the reference tree (independently authored SVG).

## Comments

2026-10-27: Filed from owner instruction; seat/glyph findings gathered read-only; no code changed.

2026-10-27 (implemented): Dispatcher mark is now an inline SVG bot portrait; the text glyph
`DISPATCHER_GLYPH = "◆"` is gone.

Mechanism: `DispatcherPortrait` renders one 16×16 `svg` (`viewBox="0 0 16 16"`, `aria-hidden`) inside
the unchanged wrapper span. The drawing is original and built from primitives: an antenna stem plus
tip dot, a rounded head rect with a 10%-opacity fill and a 1.2px `currentColor` outline, two small
side ears, two eye circles, and a short mouth line. Colours: `currentColor` everywhere, plus
`var(--dsw-alias-label-primary)` for the eyes — no hex/rgb/hsl, no brand-primary, no asset or data
URI. The component emits `SESSION_KIND_GLYPH_CSS` through a `<style>` sibling of the mark: the wrapper
becomes a 16×20 inline-flex centring box; `@keyframes multitask-dispatcher-kind-glyph-bob` moves the
portrait ±0.75px over 3.2s; `@keyframes multitask-dispatcher-kind-glyph-blink` squashes the eyes
(`scaleY(.15)`, `transform-box:fill-box`) briefly every 4.8s. A
`@media (prefers-reduced-motion: reduce)` rule sets `animation:none` on both animated parts, leaving
the static portrait. All classes/keyframes are `multitask-dispatcher-` prefixed. Worker glyph `↳`,
normal-kind `null`, kind resolution and the single additive registration
(`src/client/index.ts:307-316`) are untouched.

Files: `src/client/session-kind.tsx` (portrait + `SESSION_KIND_GLYPH_CSS` + `KindGlyphBody` body swap;
`DISPATCHER_GLYPH` removed, its `glyph` prop dropped); `test/client-session-kind.test.ts`;
`test/client-theme-tokens.test.ts`.

Tests: the old pins (`mark.textContent === DISPATCHER_GLYPH`, `DISPATCHER_GLYPH.length === 1`) are
replaced by structural ones — `svg` inside the mark with the 16×16 viewBox, eyes/head present, no
`img`, `aria-label`/`role="img"` intact, `textContent === ""`. A new DOM test proves the dispatcher
mark is structurally different from the worker mark (svg vs character). A stylesheet test pins both
keyframes, the reduced-motion override covering both animated parts, the `multitask-dispatcher-`
namespace, and the no-raw-colour rule; a render test pins that the `<style>` ships with the mark.
`client-theme-tokens.test.ts` adds `SESSION_KIND_GLYPH_CSS` to the themed-surface loop and pins its
exact token set to `--dsw-alias-label-primary`.

Gates (worktree, offline): `build:client` then `check:client` fresh; `typecheck` clean; full suite
1566/1566 pass, 0 fail; `lint:docs` clean (0 findings, both indexes fresh). No live/browser run.
