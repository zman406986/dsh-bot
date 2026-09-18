# 33 — Close-out: clean-room LQA gate + full-diff provenance review + merge to main (ticket 17)

**Blocked by:** 27, 28, 29, 30, 31, 32.
**Status:** open

## Problem

`clone/always-on-dispatcher` merges to `main` only after the three gates in `.scratch/clone-always-on/worktree-workflow.md` §3. Tickets 27–32 added client CSS, locale faces, prompt/policy copy, and adapter copy — exactly the artifact classes where provenance contamination would hide, so the branch-wide pass must run over the WHOLE ticket-17 diff, not per-ticket slices.

## What to do

Work happens per the workflow doc: tests/greps run in the worktree checkout `C:\Users\TZhen\Desktop\dsh-bot-always-on`; the recorded review comment and ticket-17 close-out land on MAIN.

- [ ] **Gate 1 — clean-room identifier grep** over the full `main...clone/always-on-dispatcher` diff per `docs/research/clean-room-license-audit.md`: case-insensitive `rg` for `sand`, `executor`, `MessageSubagent`, `SAND_MULTITASK_*` and reconstruction basenames across every touched file (source, prompts, copy strings, comments, test fixtures, compiled client output). Only intentional `FORBIDDEN_VOCAB` negative-test fixtures may hit, in `test/` only.
- [ ] **Manual copy read:** read every new prompt asset, locale string, and user-visible copy line added by 27–32; confirm original expression (design-17 §7 is the only sanctioned source) and en/zh key parity.
- [ ] **Gate 2 — offline tests green in the worktree:** `npm test` 0 fail and `npm run typecheck` clean (both configs), no network/LLM/running dsh (S8); record the counts.
- [ ] **Gate 3 — full-diff provenance review:** a human-free review of the complete branch diff for structural/phrasing/protocol borrow from the reference tree (per workflow §3), findings appended as a dated comment on `Issue-tracker/open/17-behavior-clone-reference-always-on-dispatcher.md` on MAIN.
- [ ] Confirm the §5 conflict markers were honored: spot-check each `revisit-before-merge` row of design-17 §5 against the landed code (e.g. no stop control, no todo board, no second wake kind, session "always" rows cleared) and record each check in the review comment.
- [ ] Merge `clone/always-on-dispatcher` → `main` (squash or merge, implementer's choice) with every message referencing the closed ticket numbers (e.g. `17.27`–`17.33`); then `npm ci` on main so `node_modules` matches the lockfile, and re-run the suite once on main.
- [ ] Close tickets 27–33 (and ticket 17 Phase 3) with dated comments carrying commit hashes; never `git add -A` at any step.

## Constraints

- The reference tree stays closed in both checkouts — the grep runs against OUR diff only.
- Merge gates are hard: any grep hit outside allowed fixtures, any red test, or a missing provenance comment blocks the merge.
- One implementation ticket at a time was the rule through 27–32; this ticket runs only after 32 is committed.
- Tracker/status updates on MAIN; product code and the merge happen via the worktree branch.

## Comments

2026-09-18 — **Merge step complete.** `clone/always-on-dispatcher` (HEAD `1e7c735`) merged into `main` `--no-ff` at **`400450f`**; message references 17.27–17.33 per this ticket's convention. Pre-merge sanity: worktree HEAD `1e7c735` confirmed, main `98a1262` clean, `git merge-tree --write-tree` zero conflicts. Merged tree carries both main's ticket-34 `dsh.client.inject` and the branch's capsule implementation (43 files, +9340/−252).

**Post-merge gates on merged main — all green:**
- `npm ci` — clean install from lockfile, 0 vulnerabilities.
- `npm test` — **701 pass / 0 fail / 185 suites** (union of both tips, as predicted). The known semantic-overlap risk in `test/client-face-scaffold.test.ts` did not materialize — git auto-merged it and the suite is green; no reconciliation fix was needed.
- `npm run typecheck` — clean (`tsconfig.json` and `tsconfig.client.json`).
- `npm run build:client` — OK; client bundle 64,658 bytes.

**S7 legal grep (post-merge, shipped tree) — PASS.** Word-aware, case-insensitive scan of `src/`, `lib/`, `client/`, `scripts/`, `docs/` (`prompts/` not present) for `sand`, `executor`, `MessageSubagent`, `SAND_MULTITASK_`: zero hits in the product tree. The only added hit versus pre-merge is the sanctioned negative-test array inside `test/composition-polish.test.ts` (an assertion that shipped copy is free of the identifiers). `docs/` hits are pre-existing main prose — the clean-room audit doc quoting its own methodology, research notes citing reference paths, and one generic host-API "executor" mention — none introduced by the merge (the merge adds only `docs/surfaces.md`, which scans clean). A separate scan of all 43 diff-added hunks confirms the same.

**Provenance + §5 revisit rows:** recorded as a dated comment on `Issue-tracker/open/17-behavior-clone-reference-always-on-dispatcher.md` this date — 43 files clean, gate evidence cited, rows 1–8 spot-checked PASS, and row 4's required note recorded: default-activation remains unadopted by choice, not oversight (activation only via explicit `/dispatcher-start`).

**Remaining after this step (NOT done here):** the live browser pass, then the closures — tickets 27–33 and ticket 17 Phase 3, each with dated comments carrying commit hashes. No AC above is checked off by this step; no ticket file moved.

### 2026-09-18 — live browser pass (Playwright headless Chromium per ADR-0015): PARTIAL PASS — dormant/client-face assertions green; activation-dependent assertions **blocked** by host-half `apply` never running

Setup: real launcher route reproduced verbatim (`dsh --profile web --patch %TEMP%\dsh-bot-main.patch.yml --port 8799 --no-open`; overlay identical to `dsh-bot.ps1 -Checkout 1 -DryRun` output; `npm run build` + `build:client` re-run first). Playwright headless Chromium driven from an out-of-repo tools dir. Kill timers armed at every launch (port-keyed `taskkill /F /T` for the dsh server, commandline-keyed for Playwright Chromium; one timer fired on schedule mid-pass and was re-armed). Evidence root: `C:\Users\TZhen\Desktop\dsh-live-pass-2026-09-18\` (outside the repo — `git status` clean; nothing committed but this comment). Stock `web` profile untouched (cordis.patch.yml still `[]`); disposable `multitask` profile created for one fix attempt and deleted after.

**PASS — ticket 34 AC 2 (served page / boot graph / bundle route):**
- Served page boot graph contains the row: `{"id":"dsh-multitask-dispatcher","url":"/plugins/??dsh-multitask-dispatcher/client.js&rev=…","inject":["@deepseek-ai/dsh-client-ui-renderer","@deepseek-ai/dsh-client-locale"],…}` and the plugin appears in the combo bundle list (`served-page.html`).
- Combo route serves our module: 64,914 bytes, contains `id: "dsh-multitask-dispatcher"` and `multitask-dispatcher-capsule` (`combo.js`). (A plain `/plugins/<name>/client.js` route 404s — the combo URL from the boot graph is the real route; Finding 3's check should pin that.)
- Shell did not crash: zero pageerror/console-error events while idle and interacting (`01-initial-load.png`, `13-collapsed-final.png`).

**PASS — ticket 34 AC 3 evidence + dormant side of epic AC 1 (fresh, non-activated chat):**
- Exactly one `.multitask-dispatcher-capsule` entry; collapsed chip `data-expanded="false"`, `data-dot="dormant"`, chip text empty (no invented worker count / wake badge).
- Expand → card: `__activation[data-composition="dormant"]`, state line, pitch body, single start affordance `data-intent="start"`; roster sections and deliverables line absent (count 0); footer present with copy-only Settings hint, flag segment honestly omitted (`data-flag="unknown"` — the settings-mirror watch never delivered). Screenshot `shots/02-dormant-panel.png`.
- Collapse → chip again (`data-expanded="false"`, `shots/13-collapsed-final.png`); full expand/collapse cycle clean on a second boot.

**BLOCKED — activation-dependent set (34 AC 4; epic AC 1 activated composition; tickets 09/10/11 live smoke; ticket 32 live presence):** `/dispatcher-start` typed into the dsh composer was **not intercepted as a command — it reached the LLM as plain prompt text** (session screenshots `03`/`04`; the turn's own analysis says so verbatim).

**live pass blocked:** the plugin's host-half `apply` never runs on either boot route. Diagnostics:
1. Settings → 插件配置 never shows a "Multitask Dispatcher" section (the first thing `apply` installs) — `shots/06-settings-plugins.png` (web+overlay), `shots/11-multitask-profile-settings.png` (persistent install).
2. Capsule footer stays `data-flag="unknown"` — the client's watch on our settings namespace never receives a document, i.e. the section/mirror channel never existed server-side.
3. Fix attempt inside budget: created the dedicated `multitask` profile from the web template, `dsh plugin --profile multitask add file:<repo>` (persistent install, warning noted: "declares no dsh.bundle — installed as a plain dependency"), insert row in its `cordis.patch.yml`, rebooted → identical result.
4. Not our artifact shape: composed tree contains the insert at root (`web-patched-config-dump.yml:540-544`, `name: file:///…/lib/index.js`, `enabled: true`); the service-providing packages ARE composed (`multitask-config-dump.yml` — user-questions:38, jobs-local:49, storage-domain:78, commands:184, subagent + subagent-spawn-in-process:258-261); built entry exports the standard Cordis shape (`export { Config, apply, inject, name }`).
5. Plugin inventory lists the package as an enabled global plugin (`shots/09-plugin-search-result.png`) — loaded, but never applied.
Working hypothesis (for whoever picks this up): the declared inject set (`subagents`,`agents`,`jobs`,`storageDomain`,`tools`,`commands`,`userQuestions`) never resolves at the plugin's scope on dsh 0.1.5-rc.1, so Cordis defers `apply` indefinitely — these are typert-registered services, and ticket 09's deferred live smoke item 1 ("confirm plugin loads without inject-missing errors; profile must mount subagent + spawn-in-process + jobs + storage stack") is exactly the check that fails. Needs dsh-side investigation (or a dsh debug surface for cordis inject state) before the live pass can resume; no code change is indicated on our side by this evidence.

**Token discipline incident (recorded honestly):** the plain-text `/dispatcher-start` triggered ONE unintended LLM turn (381K tok context, ~90% cache-hit, 36s, read-only tools — List/Glob/Grep/read/inspect; it spawned no workers and wrote nothing) before ending on its own. That was the only live LLM call of the pass; the budgeted worker spawn / steer / stop were never reached. The composer's slash-command interception failing silently is what converted a no-token command into an LLM turn — worth a guard note for future live passes (verify the command is registered — e.g. the settings section exists — before typing any slash command).

No AC checkbox is ticked by this comment; no ticket moved; closures stay pending on a resumed live pass.

### 2026-09-18 — ticket 43 live re-pass complete (evidence: `C:\Users\TZhen\Desktop\dsh-live-repass-2026-09-18\`): host-half apply now PROVEN on the profile route — row live in the running tree, settings namespace + schema registered service-side, clean boot, zero LLM calls spent. PARTIAL overall: the activation command still does not resolve in the host admission view (`commands/execute` A/B: `/goal` matches, `/dispatcher-start` unmatched), the section is not rendered in Settings → 插件配置, the composer menu lacks the command, and the footer flag stays `unknown` — a NEW downstream diagnosis (registration-timing idiom vs `dsh-command-compact`'s generator-effect pattern), recorded on ticket 43 with probe evidence. The activation-dependent set (34 AC 4, epic 35 AC 1, live smoke 09/10/11/32) therefore remains deferred; the token-burning flow was deliberately not run (leak guard). ACs touched: only ticket 43's AC 1 (offline gate) and AC 5 (log recorded) are checked.

### 2026-09-18 — live re-pass #2 complete (evidence: `C:\Users\TZhen\Desktop\dsh-live-repass2-2026-09-18\`): ticket 44's command fix PROVEN live — commands registered, slash menu live, RPC A/B both match, activation real (policy injects); flow BLOCKED by NEW ticket 45 (tool schemas invalid → provider rejects every activated turn); capsule stays dormant (client watch defect) — closures remain pending

Boot per the ticket-43 recipe on a throwaway `multitask` profile at `c4a7f29` (build + build:client first, insert row pre-boot, healthy boot, kill timers armed at launch — one scheduled backstop fired mid-pass on schedule and was re-armed; profile deleted after; stock `web` profile untouched; zero product changes). Token discipline held: the only LLM contact of the pass was ONE dispatcher turn, refused at request validation by the provider (INVALID_REQUEST, no completion) — this is ticket 45, filed today with root cause (`required: true/false` booleans serialized inside property schemas on all five dispatcher tools). The planned trivial flow (worker → steer → stop) is impossible until it lands, so the leak-guard worked as designed: composer slash input was never submitted before the RPC A/B proved registration.

Green on this pass (zero-LLM): `commands/list` includes `dispatcher-start` + `dispatcher-steer`; composer slash menu shows both; `commands/execute` A/B — `/goal` matched, `/dispatcher-start` matched with the full success copy; settings namespace registered with our schema; dormant capsule renders (chip/panel/pitch, zh face). Red/blocked, recorded with root causes on ticket 44: Settings 插件配置 section absent (needs a client-side `settings.plugin.item` registration — shipped cards are explicit client registrations); footer flag `unknown` + capsule never flips (client `ctx.inject(["settings"])` watch never fires, even with a roster document present in the namespace); toolviews unrenderable (ticket 45). Ticket ACs touched this pass: only dated comments — 44 ACs 2/3 stay unchecked with split green/red evidence, 34 AC 4 and epic 35 AC 1 stay unchecked, smoke-level "live smoke observed" comments added on 09/10/11/32, new ticket 45 filed. Remaining before ANY closure: ticket 45 (schema fix) + the client watch/section defects, then ONE more live re-pass running this pass's exact probe chain (`rpc-*.json` technique, reusable driver in the evidence dir).

### 2026-09-18 — Session paused by human: remaining live-verification blockers are tickets 45 (fixed, 6fc92c4, live ACs unchecked) and 46 (client watch/settings card, needs-triage); next live re-pass covers 44(c), 45 live ACs, 46, epic 35 AC 1 activated side, 34 AC 4, smoke 09/10/11/32.

### 2026-09-18 — offline blocker queue cleared one more step (ticket 46 watch half, `c91a937`)

Ticket 46 is triaged (both root causes confirmed with citations) and its **watch
half is fixed offline**: the client data path was waiting on a service that does
not exist in the browser (`settings` — the host seam) instead of the shipped
`ctx.settingsScope` bound per namespace, so the inject body never ran and the
store never left `waiting`; that single fix is what kept the capsule dormant and
the footer flag `unknown` in every live pass. Gates on the change: `npm test`
711/0/186 suites (+5 pins, RED-verified against the old name: 7 failures),
typecheck clean both configs, `build:client` OK. Its card half is split out as
**ticket 47** (no `settings.plugin.item` registration), which is the remaining
offline-actionable item for the next live pass.

**Next live re-pass therefore covers, in this order:** (1) the ticket-46 watch —
capsule flips client-side, footer flag reads a real value; (2) ticket 47 once
implemented — the 插件配置 card renders; (3) ticket 45's live ACs (its offline fix
landed at `6fc92c4`); (4) ticket 44 AC 3's token flow and AC 2's client-surface
clauses; (5) epic 35 AC 1's activated side, 34 AC 4, smoke 09/10/11/32 — all with
the same zero-LLM probe chain first (`rpc-*.json` technique in the re-pass #2
evidence dir). No AC on this ticket is checked by this comment; no ticket moved.
