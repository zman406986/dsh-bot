# 89 — Delete the retired capsule source assets (post-cutover dead code)

**Status:** resolved
**Labels:** needs-triage
**Blocked by:** none
**Related:** 65/66/73 (this is the disposition lane's surviving follow-up — the tickets
themselves are cancelled, subsumed by the shell), 78 (the cutover that retired the vehicle),
81 (assigned its unrendered-toolview question to this disposition), 49 (token theming —
constraint if any retained component survives)

## Problem

Ticket 78's cutover (commits `94e6127`, `a44084a`, `c437ee8`, 2026-09-19) retired the
capsule and staging-launcher registrations: the wrapper shell frame is now the dynamic
`root` entry, and no `shell.overlay` registration remains. The sources were deliberately
RETAINED as re-host assets, with dead-code disposition assigned to the then-open 65/66/73
lane (`src/client/index.ts` module comment; ticket 78's cutover notes). The 2026-09-19
65/66/73 disposition cancelled all three as subsumed by the shell — leaving the retained
assets with no owner. This ticket is that disposition: delete what nothing consumes, keep
what the live composition still uses.

## Verified asset state (2026-09-19, pre-work inventory)

Dead or vestigial (git-tracked, candidates for deletion):

- `src/client/capsule.tsx` (~387 lines) — ZERO importers in `src/` or `test/`.
- `src/client/capsule-store.ts` (~529 lines) — vestigial: `CapsuleStore` is constructed in
  `apply`/`applyClientModule` but no method is ever called on it; `CapsuleFooterStore` is
  still fed by the settings watch (`footer.applyChannelValue`) but rendered by NOTHING
  (its only renderer was capsule.tsx). `actions.ts` imports only the
  `CapsuleActivationIntent` type from it.
- `capsule.*` locale keys in `src/client/overlay.ts` (~21 keys × en+zh ≈ 42 lines) — no
  live renderer consumes them; `actions.ts`'s `CAPSULE_ACTION_*` /
  `CAPSULE_STOP_MESSAGE_KEY` constants referencing them are themselves consumed only by
  `test/client-capsule-actions.test.ts` (the live conversation pane has its own
  `shell.conv.*` copy).
- `src/client/shell.tsx`: `createShellLauncher` + `SHELL_LAUNCHER_CSS` +
  `SHELL_LAUNCHER_CLASS` — the retired staging chip, zero consumers.
- `src/client/shell-mount.ts`: launcher-only contracts (`SHELL_LAUNCHER_ENTRY_ID`,
  `SHELL_LAUNCHER_OVERLAY_ORDER`, `shellLauncherRegistration`, `createShellLauncherLayout`)
  — consumed only by `test/client-face-scaffold.test.ts`. CAREFUL: keep the LIVE main-page
  contracts (`SHELL_PAGE_KEY`, `shellPageRegistration`, `openShellPage` if still bound) —
  the `main` page registration STAYS per 78's pinned staging contract (dormant behind the
  frame election, self-restoring on abdication).
- `src/client/index.ts`: dead `capsule`/`footer` parameters of `applyClientModule`, the
  `footer.applyChannelValue` feed, and the launcher/staging remnants.
- Tests: `test/client-capsule-chip.test.ts`, `client-capsule-activation.test.ts`,
  `client-capsule-composition.test.ts`, `client-capsule-actions.test.ts` (plus the
  launcher-layout assertions in `client-face-scaffold.test.ts` and the
  `createCapsuleFooterStore` default in `client-onboarding.test.ts`) — retire or adapt
  with the sources they pin.

Verify-while-there (flagged by ticket 81, riding this same disposition): post-cutover the
five `tool.call.toolview` slot entries (ticket 24) are registered but UNRENDERED — the
frame displaces the host chat and 80's conversation pane renders tool rows from the event
window. Confirm and include their retirement in this same sweep if still true.

## Constraints

- Deletion only — NO rebuild, no behavior change: the shell surface is untouched; gates
  after the sweep are the standard offline ones (`npm test`, `npm run typecheck`,
  `npm run build:client`).
- One vocabulary rule: if any `capsule.*` copy is still the best wording for a live
  surface, MOVE the key rather than duplicate it (ticket 79's shared-`roster.blocked.*`
  discipline).
- Keep the module-comment history honest: update `src/client/index.ts`'s numbered
  registration list (items 3 and 6 are already struck through as retired) to record the
  deletion instead of "retained as assets".

## Acceptance criteria

- [x] `capsule.tsx` / `capsule-store.ts` deleted; no `src/` or `test/` reference
      remains (grep clean for `capsule` outside historical comments/ADR docs).
      *(2026-09-19, verified in this pass: both files absent; the sweep grep
      `capsule|CAPSULE_CSS|CapsuleStore|CapsuleFooterStore|createCapsuleFooterStore|CapsuleActivationIntent|CAPSULE_ACTION_|CAPSULE_STOP_MESSAGE|createShellLauncher|SHELL_LAUNCHER_|openShellPage|createShellLauncherLayout|shellLauncherRegistration`
      over `src/ test/` returns 71 lines, **every one inside a comment or a
      test title**; zero code reference, zero import of `capsule.js` /
      `capsule-store.js` / `capsule.tsx`.)*
- [x] Dead `capsule.*` locale keys and launcher contracts removed; live main-page
      contracts intact and still registered.
      *(2026-09-19: `grep '"capsule\.' src/client/overlay.ts` → 0 hits; the
      launcher contracts/component are gone from `shell-mount.ts`/`shell.tsx`.
      LIVE contracts verified present — `src/client/shell-mount.ts:63` `MAIN_PAGE_SLOT`,
      `:70` `SHIPPED_MAIN_PAGE_KEY`, `:77` `SHELL_PAGE_KEY`, `:90`
      `shellPageRegistration`, `:108` `ROOT_FRAME_SLOT`, `:190`
      `shellRootRegistration` — and REGISTERED: `src/client/index.ts:420`
      `ctx.slots.inject(MAIN_PAGE_SLOT, …)` → `shellPageRegistration()` at
      `:428`; `:466` `ctx.slots.inject(ROOT_FRAME_SLOT, …)` →
      `shellRootRegistration()` at `:474`.)*
- [x] `applyClientModule` signature and the settings watch lose the vestigial feeds;
      toolviews (24) either stay (with a recorded live-consumer justification) or go per
      the verify-while-there finding.
      *(2026-09-19: signature is now `applyClientModule(ctx, store, card,
      onboarding)` — `src/client/index.ts:229-234`; the settings watch feeds
      only `store.applyChannelValue` + `approvalFeed.applyChannelValue`
      (`:317-318`), no capsule/footer reader. **Toolviews STAY** — six entries,
      `src/client/index.ts:361-370` (`:350`/`:355` in the pre-pass numbering);
      justification in the dated comment below: the abdicated stock frame's
      chat is the live consumer (fallback path), recorded as **unverified
      live** rather than deleted on a guess.)*
- [x] Gates green offline; no live pass required for a pure deletion (unless toolviews
      are removed, in which case one trivial-task live smoke under ticket 33's rules).
      *(2026-09-19: toolviews NOT removed, so no live pass is owed.
      `npm run typecheck` clean (both configs); `npm test` **1044 pass / 0 fail**
      (256 suites); `npm run build:client` green — `client\index.js`, 161,087 B.)*

## Comments

### Handover 2026-09-19 (session end)

The deletion agent was cancelled mid-flight. Its uncommitted work was **kept, not reverted**: `npm run typecheck` clean (both configs), `npm test` **1044 pass / 0 fail** (256 suites), `npm run build:client` green (161,087 B) — frozen as **`d25d6ef`** ("Ticket 69/89: WIP checkpoint from cancelled agent … tests green"). Worktree clean at session end. The sweep looks **offline-complete** against the corrected inventory, but the ACs above are deliberately left **unticked**: tick them only after the read-through below (this comment asserts only what the gates prove).

**Corrected inventory (supersedes the pre-work list's undercount — read this first):** the deleted tuple was the 4 capsule test files (`client-capsule-chip`, `client-capsule-activation`, `client-capsule-composition`, `client-capsule-actions`), PLUS **4 further test importers the pre-work inventory missed** — `test/client-theme-tokens.test.ts` (carried the `CAPSULE_CSS` token assertions), `test/restart-honesty.test.ts` and `test/composition-polish.test.ts` (both imported `capsule-store`), and `test/client-onboarding.test.ts` (`createCapsuleFooterStore` default). All four were adapted, not deleted. **Main-page contracts must stay live** — confirmed intact in `d25d6ef`: `SHELL_PAGE_KEY`, `shellPageRegistration` (still registered, `index.ts:417`), `MAIN_PAGE_SLOT`/`SHIPPED_MAIN_PAGE_KEY` and every `root`-election contract; only the launcher/staging remnants (`SHELL_LAUNCHER_*`, `createShellLauncher`, `shellLauncherRegistration`, `createShellLauncherLayout`, `openShellPage`) went.

**State left in the tree:** `capsule.tsx` (387 lines) and `capsule-store.ts` (529) deleted; `capsule.*` locale keys removed from `overlay.ts`; launcher code removed from `shell.tsx`; launcher-only contracts removed from `shell-mount.ts`; `applyClientModule`/the settings watch lost the capsule/footer parameters and the footer feed (`actions.ts`, `index.ts`); `index.ts`'s numbered module comment now records the deletion (items 3/6) instead of "retained as assets"; `grep` for `capsule`/`CAPSULE_CSS` over `src/` + `test/` is clean outside historical comments/ADRs. **Not verified within this sweep:** the verify-while-there toolview finding (five `tool.call.toolview` entries possibly unrendered post-cutover) — no claim made either way.

**Successor next steps:** (1) read `src/client/index.ts:390-470`, `shell-mount.ts` and `shell.tsx`, then tick ACs 1–2 if they match (evidence: `d25d6ef`, gates above); (2) settle AC 3's toolview clause — record a live-consumer justification or fold the retirement into a follow-up commit; (3) AC 4: a pure deletion needs no live pass (the optional trivial-task smoke applies only if toolviews are removed); (4) do NOT reintroduce `openShellPage`/launcher registrations — the `main` page stays dormant behind the frame election per ticket 78's pinned contract.

### 2026-09-19 — agent (read-through pass: all four ACs ticked, ticket RESOLVED; toolview clause = STAY; two verifier caveats fixed)

Ran the handover's successor steps 1–4. Read `src/client/index.ts:390-470` (now `:389-476`), `shell-mount.ts`,
`shell.tsx`, plus `context.ts`. The `d25d6ef` deletion holds as reported; the ticks above carry the exact grep
commands, line anchors, and gate numbers.

- **AC 1 — ticked.** Deletion confirmed complete, no dangling import. The sweep grep returns 71 lines in
  `src/ test/`, all inside comments (`*` / `//` doc lines) or test *titles* — 5 title lines total
  (`client-shell-mount.test.ts:339,388`, `client-face-scaffold.test.ts:430`, `coexistence.test.ts:988`,
  `restart-honesty.test.ts:683`); zero code reference. Historical prose (ADR-0013/0014/0020, research notes,
  the capsule-era narrative comments) is left intact per the AC's "outside historical comments/ADR docs"
  carve-out.
- **AC 2 — ticked.** `capsule.*` locale keys: 0 hits in `overlay.ts`. Launcher contracts gone. Main-page
  contracts present and registered (`shell-mount.ts:63,70,77,90,108,190`; `index.ts:420,428,466,474`).
- **AC 3 — ticked; toolviews STAY (six, not five).** Evidence, not assumption:
  - The shipped chat is the slot's renderer — `docs/research/dsh-plugin-ui-patterns.md:76` (dsh-client-ui-tool
    declares `tool.call.toolview`, keyed by wire tool name, "an unclaimed key falls back to the generic tool
    row") and `:82` (chat rendering = node-keyed entries + per-tool rows via `tool.call.toolview`).
  - While our `root` frame holds the cell the entries are registered-but-unrendered (ticket 81's finding) —
    the ticket-80 pane renders its rows from the event window instead (`src/client/conversation-store.ts:76`
    imports `describeToolview`; `conversation.tsx:44` the degraded key).
  - The consumer is the OTHER state: on abdication the shipped frame retakes the `root` cell
    (`shell-mount.ts:23-34`, `shellCellWinner` `:224-233`) and its chat renders those keys — the entries are
    what keeps OUR rows there rather than the generic fallback row. Abdication is REAL and live-proven: ticket
    78's live pass 4 (comment, 2026-09-19) reports a genuine crash, the per-entry boundary abdicating our entry,
    and "the stock `pI_x6G_frame` retook the cell" (`shots/02-abdicated-stock-frame.png`). The registrations
    ride the module fiber's inject controller (`index.ts:361-370`), not the `root` entry, so they survive that
    abdication — deleting them would change a reachable fallback surface. **Recorded as "abdicated stock frame
    is the consumer (fallback path), unverified live"** (no live tool row was observed in the abdicated state);
    per the ticket rule, ambiguity resolves to STAY, not deletion on a guess. Ticket 81's AC premise ("toolview
    slot entries retire with the host chat") is overtaken: under 78's pinned fail-safe the host chat does not
    retire — it is displaced-yet-standby, and it is exactly the degradation surface the toolviews serve. No live
    smoke is owed (AC 4's clause applies only on removal).
  - **Count correction:** the registration is SIX entries, not five — `TOOLVIEW_TOOL_NAMES` gained `send_peer`
    under ticket 70 (`src/client/toolviews.ts:48-55`); ticket 81's phrase and this ticket's verify-while-there
    note carried the pre-70 count. Stale "five" wording corrected in `toolviews.ts`'s header and
    `index.ts`'s numbered list; the stay-justification comment is recorded in the registration block.
- **Verifier caveat (a) fixed.** `src/client/context.ts`'s stale present-tense claim about `openShellPage`
  "contain[ing]" the `selectPanel` throw went with the launcher's contract type (see below); the replacement
  comment records the deletion in the past tense.
- **Verifier caveat (b) resolved by REMOVAL.** `ClientLayoutLike` + both `layout` fields
  (`ClientInjectedServices.layout`, `ClientContext.layout`) had no live reader — only tests used the type.
  Removed as dead, misleading weight (it advertised a `ctx.layout` dependency nothing has); the guard test's
  contract survives as a tripwire with a structural inline type, so no test coverage was lost, and the guards
  stayed green. `index.ts`'s "optional faces" narrative was corrected to name `settingsScope` only.
- **Doc inaccuracy fixed.** `docs/research/no-verbatim-copy-review-2026-09-19.md`'s Findings table named 3
  fixture files carrying the forbidden vocabulary; `test/policy-assembler.test.ts:31` is a 4th. Added (the
  conclusion "only the sanctioned fixtures" still holds).
- **Gates (this pass, on the ticked tree):** `npm run typecheck` clean (both configs); `npm test`
  **1044 pass / 0 fail** (256 suites); `npm run build:client` green, `client\index.js` **161,087 B** (unchanged
  — the edits are comments/types only, no emitted-code change). Commit `wt/89` (see the merge-lane log).

**Disposition:** all four ACs satisfied offline → ticket moved to `Issue-tracker/resolved/`. Remaining work:
none on this ticket; the toolview stay is recorded with its live caveat, and no browser/LLM pass was run.
