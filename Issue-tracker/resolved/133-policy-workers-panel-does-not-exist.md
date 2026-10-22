# 133 — Dispatcher policy says progress shows in "the workers panel", which no longer exists

**Status:** resolved
**Labels:** needs-triage
**Blocked by:** nothing
**Related:** ADR-0024 (floating window, launcher, and capsule withdrawn; stock dsh is the UI — the ruling that owns whether any panel returns), ticket 114 (removed the floating window; composition re-based to the native posture), ticket 123 (session-kind glyph — the one additive layout registration since), ticket 119 (its 2026-10-22 comment flagged this as out of scope), ticket 132 (the sibling dead-doctrine line in the same policy file)

## Problem

`buildDispatcherPolicySection()` (`src/core/policy/prompts.ts:135-172`) puts this line in the dispatcher's "How you work" doctrine, at `src/core/policy/prompts.ts:161`:

> `- Progress is conveyed by your own narration and the workers panel; never reference a task board or milestone view.`

There is no workers panel in the default posture.

## Verification (2026-10-22, checked against code)

**What the model is told.** Progress reaches the user through two things: its own narration and "the workers panel".

**What exists.** The default client composition (`src/client/index.ts`) makes these layout registrations and nothing else:

- the `multitask-dispatcher` locale namespace (`:210-213`, not layout);
- keyed `tool.call.toolview` entries for the dispatcher tool rows (`:251`);
- the keyed plugins-row settings card (`:280`);
- the worker and dispatcher session-kind glyphs in the conversation header (`:306`, `:317`).

`mountShellPage` — the only path that composes the roster ("workers") panel — is not called by any composition inject (`src/client/index.ts:45`, `:229`, `:356`), so the returned `mounts` array is empty by default. `docs/surfaces.md:150` and `:250` list the panel (`src/client/panel.tsx`, `src/client/roster-store.ts`) as **Retained, unmounted**; `docs/surfaces.md:25-28` says the panel's "Needs you" route is dormant in the default posture.

ADR-0024 decision 2 (`docs/adr/0024-native-dsh-posture-restored-by-human-ruling.md:14`) withdraws the floating surface and composes no chrome of ours; decision 4 keeps `mountShellPage` in the tree so a future surface can be registered at one site — that is reversibility, not a live panel. Ticket 114's completion record (`Issue-tracker/resolved/114-upgrade-dsh-0-2-x-and-revert-ui-to-native-posture.md:52`) confirms the composition registers exactly four injects and no shell/launcher entry.

**Model-facing copy: this is the only occurrence.** A repo-wide grep for "workers panel" in `src/` hits only `src/core/policy/prompts.ts:161`.

## Stale or actively misleading?

Both, with the second being the risk:

- **Stale** — it names a surface the user cannot see. The panel mechanism exists in the tree but nothing mounts it.
- **Actively misleading** — the line is instruction, not description. It tells the model that progress is already conveyed somewhere besides its narration. A model that believes a panel shows progress can under-narrate. That contradicts the surrounding doctrine: `:162` ("The user never hears the machinery"), `buildStandingRulesBlock()`'s "Never name the machinery" (`:183`), and the wake instructions' silence rule (`:199`). The shipped setup has exactly one live progress route: the dispatcher's chat narration (`docs/surfaces.md:29-31`).

The neighbouring clause — "never reference a task board or milestone view" — is unaffected and is pinned by `test/restart-honesty.test.ts:1102`. The first clause has no pin.

## Why file rather than fix

A one-line policy edit is enough for the text. But whether a workers panel (or any roster surface) returns is ADR-0024's ruling, and a future panel would make the original line true again. Editing doctrine before that ruling risks writing the policy twice. This ticket records the mismatch and leaves both the wording and the surface question to the owner.

## Options (this ticket picks none)

1. **Rewrite the clause to the live route** — "Progress is conveyed by your own narration" (drop the panel), matching `docs/surfaces.md:29-31`. One line, no code. Breaks no existing pin.
2. **Keep the sentence and restore a panel** — an ADR-0024 amendment plus a new surface ticket. Larger, and the owner has already ruled the native posture.
3. **Leave both until the post-0.2.1 surface question settles.** Cheapest; the line stays wrong for the model in the meantime.

## Evidence

`src/core/policy/prompts.ts:135-172` (line at `:161`), `:183`; `src/client/index.ts:45`, `:210-213`, `:229`, `:251`, `:280`, `:306`, `:317`, `:356`; `docs/surfaces.md:25-28`, `:29-31`, `:150`, `:250`; `docs/adr/0024-native-dsh-posture-restored-by-human-ruling.md:14`; `Issue-tracker/resolved/114-upgrade-dsh-0-2-x-and-revert-ui-to-native-posture.md:52`; pin `test/restart-honesty.test.ts:1102`.

## Constraints

- This ticket edits no `src/` and no test. Ticket 119 stays untouched.
- Option 2 must amend ADR-0024 first; no surface may be composed on the strength of this ticket alone.
- Option 1 must keep the "no task board or milestone view" clause — it is pinned.

## Comments

### 2026-10-22 — filing

Filed from ticket 119's 2026-10-22 comment ("Contradiction found, not fixed", item 2), re-verified against the current composition before filing. The comment cited the line without a number; it is `src/core/policy/prompts.ts:161`. Ticket 119's claim that the panel is retained-but-unmounted since ADR-0024/ticket 114 is correct, and the default composition is exactly locale + toolviews + settings card + two session-kind glyphs.

### 2026-10-22 — final verification: the dead claim ships to the user, not just to the model

This ticket understates its own finding. The sentence "Model-facing copy: this is the only occurrence" above is true only for the lowercase phrase and only for model-facing text. The same dead reference ships as **user-facing copy** in two places, and one of them is printed on the activation path.

**1. `/dsh-bot` success text — user-facing, live.** `src/adapter/activation-command.ts:44-46`:

> `export const ACTIVATION_PRESENCE_HINT =`
> `  "The Workers panel shows live progress; results arrive in this chat as " +`
> `  "they finish.";`

The rendered string is: "The Workers panel shows live progress; results arrive in this chat as they finish."

It is appended exactly once to `DISPATCHER_START_SUCCESS` (`src/adapter/activation-command.ts:49-52`), and that constant is the returned text on a successful activation: `activationResultCopy()` returns `{ kind: "success", text: DISPATCHER_START_SUCCESS }` (`:92-93`), and the command handler returns `activationResultCopy(options.activate(agent))` (`:123`). The command is registered live (`src/plugin.ts:1280-1286`, effect label "multitask-dispatcher: dsh-bot command"), and `docs/surfaces.md:245` lists it as **Live — `/dsh-bot` in the stock chat**.

**Is this the message the user sees immediately after typing `/dsh-bot`? Yes.** On a successful activation the handler's return text *is* `DISPATCHER_START_SUCCESS`, so every successful activation prints the claim about a panel that is not there. (Re-running the command in an already-active chat returns `DISPATCHER_START_ALREADY_HERE` instead and prints no panel claim; so it is every activation, not every invocation.)

**2. The registered locale face — user-facing copy, shipped, unrendered today.** `src/client/overlay.ts:154-155`:

> `"activation.presence-hint":`
> `  "The Workers panel shows live progress; results arrive in this chat as they finish.",`

The dictionary is registered live (`src/client/index.ts:210-213`), so this string ships in the client bundle. No code reads the key today — the module comment at `src/client/overlay.ts:148-153` says the host command result is the surface — so this face is shipped-but-unrendered user copy. Its zh twin carries the same claim at `src/client/overlay.ts:339-340`: "“工作者”面板会显示实时进度；结果完成后会直接送达本聊天。"

**The defect is broader than a doctrine slip.** ADR-0024 decision 1 (`docs/adr/0024-native-dsh-posture-restored-by-human-ruling.md:14`) says the module registers nothing into dsh's layout, decision 2 withdraws the floating surface, and `docs/surfaces.md:150` lists the roster panel as retained, unmounted. So the activation path does not merely tell the model something false — it makes a **broken promise to the user** at the moment of opting in. That is worse than the policy line: the model can under-narrate because it believes a panel shows progress, and the user can expect a panel that never appears.

**Full grep result set** (case-insensitive `workers panel` over `src/`):

| file:line | class |
|---|---|
| `src/adapter/activation-command.ts:37` | comment (JSDoc describing the hint: "lives — the app-wide Workers panel") |
| `src/adapter/activation-command.ts:45` | user-facing copy — activation success text, **live** |
| `src/client/overlay.ts:155` | user-facing copy — en locale key, registered but unrendered |
| `src/core/policy/prompts.ts:161` | model-facing policy |

The same dead claim also appears in different wording, both user-facing and currently unreachable because the pane is retained-unmounted (`docs/surfaces.md:151`): `src/client/overlay.ts:275-276` `shell.onboard.handoff.body` ("its workers' progress shows in the panel beside it") and its zh twin at `:441-442`. Neither ships today, but if the shell returns without a copy fix they revive the same lie.

**Correction to the Options section.** Option 1 says "One line, no code. Breaks no existing pin." For the policy line that holds. For the user-facing half it does not: `test/composition-polish.test.ts:322-344` asserts `ACTIVATION_PRESENCE_HINT` equals the exact design-17 §7 draft string, `:383-402` asserts it matches `/Workers panel/`, `:362-381` pins en-locale parity with the host constant, and `test/client-face-scaffold.test.ts:448` pins `activation.presence-hint` in the key set. Any fix that drops the panel from the activation copy must move those pins with it.

Status and Labels left unchanged (`open`, `needs-triage`); the open-issue index is not regenerated by this comment.

## Resolution — 2026-10-22

Took option 1 (rewrite the clause to the live route). One line changed in
`src/core/policy/prompts.ts` (`buildDispatcherPolicySection()`):

Old (`:161`):

> `- Progress is conveyed by your own narration and the workers panel; never reference a task board or milestone view.`

New:

> `- Progress is conveyed by your own narration; never reference a task board or milestone view.`

The "no task board or milestone view" clause is unchanged, so the pin at
`test/restart-honesty.test.ts:1102` still holds.

No acceptance checkboxes existed in this ticket. No test pinned the
workers-panel clause. Post-edit grep for `workers panel` over `src/` returns
zero policy hits; the three remaining `Workers panel` hits in
`src/adapter/activation-command.ts` (`:37`, `:45`) and `src/client/overlay.ts`
(`:155`) are the user-facing activation-presence hint, a separate string with
its own pins in `test/composition-polish.test.ts`. That hint still tells the
user a panel shows progress; per this ticket's 2026-10-22 comment it is the
larger defect, but moving it means moving those pins, and ADR-0024 keeps the
surface question with the owner. Left unchanged and flagged here.

Tests run (all pass):

- `test/policy-assembler.test.ts` — 27 pass, 0 fail
- `test/restart-honesty.test.ts` — 18 pass, 0 fail
- `test/access-relay.test.ts` — 33 pass, 0 fail
- `test/access-prompt.test.ts` — 56 pass, 0 fail
- `test/adapter-policy-inject.test.ts` — 13 pass, 0 fail
