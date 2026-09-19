# 33 — Close-out: clean-room LQA gate + full-diff provenance review + merge to main (ticket 17)

**Blocked by:** 27, 28, 29, 30, 31, 32.
**Status:** open

## Problem

`clone/always-on-dispatcher` merges to `main` only after the three gates in `.scratch/clone-always-on/worktree-workflow.md` §3. Tickets 27–32 added client CSS, locale faces, prompt/policy copy, and adapter copy — exactly the artifact classes where provenance contamination would hide, so the branch-wide pass must run over the WHOLE ticket-17 diff, not per-ticket slices.

## What to do

Work happens per the workflow doc: tests/greps run in the worktree checkout `C:\Users\TZhen\Desktop\dsh-bot-always-on`; the recorded review comment and ticket-17 close-out land on MAIN.

- [ ] **Gate 1 — clean-room identifier grep** over the full `main...clone/always-on-dispatcher` diff per `docs/research/clean-room-license-audit.md`: case-insensitive `rg` for `sand`, `executor`, `MessageSubagent`, `SAND_MULTITASK_*` and reconstruction basenames across every touched file (source, prompts, copy strings, comments, test fixtures, compiled client output). Only intentional `FORBIDDEN_VOCAB` negative-test fixtures may hit, in `test/` only.
- [x] **Manual copy read:** read every new prompt asset, locale string, and user-visible copy line added by 27–32; confirm original expression (design-17 §7 is the only sanctioned source) and en/zh key parity. **(Done 2026-09-19 — see the Gate-2 comment: 93 en = 93 zh, validator clean, per-string PASS verdicts with file:line, 2 low-severity FLAGs recorded with recommendations.)**
- [ ] **Gate 2 — offline tests green in the worktree:** `npm test` 0 fail and `npm run typecheck` clean (both configs), no network/LLM/running dsh (S8); record the counts.
- [x] **Gate 3 — full-diff provenance review:** a human-free review of the complete branch diff for structural/phrasing/protocol borrow from the reference tree (per workflow §3), findings appended as a dated comment on `Issue-tracker/open/17-behavior-clone-reference-always-on-dispatcher.md` on MAIN. **(Done 2026-09-19 in its re-scoped form — no-verbatim-copy review; `docs/research/no-verbatim-copy-review-2026-09-19.md`, pointer on ticket 17.)**
- [x] Confirm the §5 conflict markers were honored: spot-check each `revisit-before-merge` row of design-17 §5 against the landed code (e.g. no stop control, no todo board, no second wake kind, session "always" rows cleared) and record each check in the review comment. **(Done: rows 1–8 recorded PASS 2026-09-18 on ticket 17's review comment; the four named examples re-verified against today's tree 2026-09-19 with file:line in the Gate-2 comment below.)**
- [x] Merge `clone/always-on-dispatcher` → `main` (squash or merge, implementer's choice) with every message referencing the closed ticket numbers (e.g. `17.27`–`17.33`); then `npm ci` on main so `node_modules` matches the lockfile, and re-run the suite once on main. **(Done — merge `400450f` 2026-09-18 with post-merge gates green (701/0/185, `npm ci` clean, typecheck clean, `build:client` 64,658 B); the box was left unticked then deliberately. Ticked 2026-09-19 with the part-2 merge train landed on main — merges `7ec5c1f`/`2cad4ce`/`4add534`/`d0bd81f` — and gates re-run on merged main: 1049/0/257, typecheck clean, `build:client` 161,087 B. `npm ci` cited, not re-run: `node_modules` is junction-shared with five live worktrees. See the 2026-09-19 AC6 comment below.)**
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

### 2026-09-18 — launcher precondition for the next pass: ticket 48

Before that pass, note two things it depends on, both landed today (`fc02eeb` +
the Desktop launcher rewrite): the web route's overlay is now the **committed**
`dev/cordis.web.patch.yml` (ticket 43 Requirement 1's repo half), and the
launcher **refuses a behind-`main` checkout** instead of silently serving one —
`dsh-bot-always-on` had been 39 commits behind since this ticket's merge and is
now fast-forwarded to `main` (`-Sync`). Both routes were booted and serve the
identical boot-graph row and byte-identical client bundle (65,320 bytes,
carrying ticket 46's `settingsScope` and confirming ticket 47's absent card).

**Pass-runner caveat (cost me three dead boots):** a launcher window started from
inside an agent tool session is reaped with that session — the server never
listens and it looks exactly like a product failure. Detach the boot
(`([wmiclass]'Win32_Process').Create(...)` or a scheduled task) before concluding
anything red, and keep the kill timer. Details in ticket 48's comment.

### 2026-09-18 — one more offline blocker cleared (ticket 49) and a new pass assertion added

Ticket 49 is implemented and verified offline: the capsule and panel no longer
paint a private dark palette — all 23 colour literals are gone and both surfaces
style entirely from the host's `--dsw-alias-*` token layer, so they follow the
shell's light/dark theme (`75932da`; gates 726 pass / 0 fail / 188 suites, +15
pins, typecheck clean both configs, `build:client` OK).

**This adds one assertion to the pass plan below, and it is cheap:** the pass
should read the chip/card colours under **both** schemes (toggle the host
theme, or evaluate the resolved `--dsw-alias-*` on `body` and compare against
the rendered element). It needs no session and no LLM, so it can ride the same
zero-LLM probe chain — ideally *before* the activation-dependent items, since it
is a dormant-side check that cannot be blocked by tickets 45/46/47.

**Worktree state:** `dsh-bot-always-on` was 2 commits behind `main` (this
ticket's earlier note plus ticket 49) and has been fast-forwarded via the
launcher's `-Sync`; it now reads `clone/always-on-dispatcher, clean, = main`, so
either launcher route serves the current surfaces.

No AC on this ticket is checked by this comment; no ticket file moved.

### 2026-09-18 — live re-pass #3 complete (evidence: `C:\Users\TZhen\Desktop\dsh-live-repass3-2026-09-18\`): pass-order items (2) and the first clause of (1) are GREEN — ticket 47 RESOLVED, ticket 46's footer flag now real; the activation-dependent set is unchanged and still waits on ticket 45

Booted from a fresh build of `9743330` on the committed-overlay web route
(`dsh --profile web --patch dev/cordis.web.patch.yml --port 8823 --no-open`,
started directly rather than through `dsh-bot.ps1`), detached via WMI node-direct
with kill timers armed at launch on BOTH wrappers. **Zero LLM calls** (no composer
input was ever submitted; the only `/api/llm/*` traffic is the two provider
catalogs) and **zero writes to the settings document** — a live
`settings/update|mutate|replace` was specifically looked for, via a patched
`window.fetch`, across every interaction and never appeared. Full write-up, probe
chain and screenshots in the evidence dir's `README.md`.

**(2) Ticket 47 — the 插件配置 card renders. RESOLVED.** `Settings → 插件 → 插件配置`
now shows, as its FIRST card, `Multitask Dispatcher` with our zh copy, a
`启用调度器` checkbox reading `true`, an `访问请求超时（毫秒）` field reading
`120000`, and 放弃/保存 disabled (nothing staged) — above the host's unchanged
终端 / Agent 循环 / Subagent / 网页搜索 rows (`shots/01`–`03`). A live
`POST /api/settings/describe` on the same boot returns our namespace `uid: 561`,
`value = base = {enabled: true, accessRequestTimeoutMs: 120000}`,
`applies: "live"`, `revision: 0`, and **no `user` key** — and the controls read
exactly that, with the per-field "已在此设置"/reset affordances correctly ABSENT
because `overridden` is presence in the user layer, not a value comparison. The
staging/degrade paths were exercised live without writing: a checkbox click
surfaced `未保存`, enabled Save + Discard and followed the draft, with no settings
write on the wire; 放弃 restored the clean state. On reload the card re-mounts and
still reads the document. That closes ticket 47's live AC, and the before/after
pair is exact — re-pass #2's `shots/05` shows the same tab with only the host's
four rows while the namespace was already served. Ticket 47's four ACs are all
green: file moved `open/` → `resolved/`, Status set.

Route caveat, stated rather than glossed: this was the committed-overlay **web**
route, not the `multitask` profile and not through the launcher script. The
launcher passes this same committed patch, the profile route's namespace presence
was proven in re-pass #2 (`rpc-settings-describe2.json`, same `uid: 561`), and the
card half is client-side and route-independent — so the AC's substance is met; a
single boot carrying both is not what was run.

**(1a) Ticket 46's footer flag is now REAL — the "unknown" symptom is gone.** On
the same boot the capsule renders once, collapsed chip empty with
`data-dot="dormant"`, and expanding it gives a footer with `data-flag="on"` and the
visible segment `调度器设置：已启用` — the client mirror reading `enabled: true` from
the served document, i.e. the `ctx.settingsScope` bind fix (`c91a937`) proven live
rather than only offline (`shots/04`). This is the exact attribute re-pass #2
recorded as `unknown`.

**(1b) The rest of ticket 46's live AC could not be reached and was not forced.**
"the capsule flips client-side" needs an activated roster; the roster key is
mirrored under `roster` in our namespace (`src/client/index.ts:21-22`) and the
dormant served schema carries exactly `enabled` + `accessRequestTimeoutMs`, so the
host half only publishes it on activation — and activation's turns are still
rejected by the provider (ticket 45), so no worker state can exist to mirror either
way. Forcing the question would have meant activating the dispatcher over RPC on
the human's live `web` profile, which writes durable host-side state; the wrong
trade for a bonus check, so it was deliberately not done and is recorded on ticket
46 instead. AC 3's first clause green, second clause blocked upstream; no box
moved, ticket 46 open.

**Not done, recorded rather than implied:** the ticket-49 request in the previous
comment — reading the chip/card colours under both schemes — was not run in this
pass. The card rendered under the host's light scheme with only `--dsw-alias-*`
tokens, which shows it follows the host theme rather than a private palette, but
that is not the two-scheme comparison that was asked for; it stays on the list.

**Still deferred, unchanged:** (3) ticket 45's live ACs, (4) ticket 44 AC 3's token
flow and AC 2's client-surface clauses, (5) epic 35 AC 1's activated side, 34 AC 4,
smoke 09/10/11/32 — all need an executable activated turn. Newly cheap for the next
pass: the probe chain, the detached-boot wrappers, and the RPC envelope shape are
all reusable in the re-pass #3 evidence dir (`tools/driver.mjs` + `tools/dcmd.sh`;
the typert gateway wants exactly one plain-object `args` field, so
`payload: {args:{}}` is the working shape for a no-arg method).

Pass hygiene: the ticket-48 caveat was honored (both wrappers detached with nothing
but quoted paths in the command line — `-File` does not run through WMI and
`-Command` mangles metacharacters), kill timers armed at launch, and the human's
`web` profile settings document left byte-identical.



### 2026-09-19 — re-scoped per ADR-0018 (ticket 64); still owns real close-out work, NOT closed

ADR-0018's consequences re-scope this ticket's gates: the clean-room identifier grep (old Gate 1,
S7) is **voided as a ship gate**; the provenance review becomes a **no-verbatim-copy review** —
no textually identical text against the reference; adapted copying is permitted (AGENTS.md, human
accepted-risk 2026-09-18). The merge itself already landed (`400450f`) with the old gates green,
so the no-verbatim re-review over the shipped diff is still owed before close-out. The remaining
live-pass chain (tickets 44/45/46/47 defects, epic 35 AC 1) targeted the capsule vehicle that
ADR-0018 supersedes — the pass plan re-scopes to the offline gates plus live assertions only for
surfaces that survive the wrapper re-base. Blocked-by list unchanged; Status stays open.

### 2026-09-19 — pointer recorded per ticket 53 §4 (re-spec); no rewrite of the merge record

Ticket 53's re-spec records that this merge (`400450f`) was judged under ADR-0004's behavioural latitude — a standard since superseded for core-loop items: ADR-0017 supplies the deviation discipline, and **ADR-0018** (accepted 2026-09-18, imitate-the-reference exception-list model) is the governing standard, which the re-scope comment above already reflects. Ticket 54's salvage pass scrapped nothing, so the merge record needs no fidelity amendment — this pointer stands in place of a rewrite. Cross-ref: `Issue-tracker/resolved/53-respec-implementation-tickets-post-salvage-audit.md`.

### 2026-09-19 — one-line note

78 cutover landed (94e6127 + a44084a) — live confirmation in pass 3.

### 2026-09-19 — one-line note

85 landed (a2c09ed) — ready for live pass 4.

### 2026-09-19 — one-line note

88 landed (d242d18) — ready for live re-confirm.

### 2026-09-19 — one-line note

87 landed (5da8a54) — ready for live re-confirm.

### 2026-09-19 — Close-out PART 1 done (ADR filings + no-verbatim review); closures remain PART 2, pending live pass 5

**ADR-0010/0011/0012 filed** as `-draft-nonhuman-approved` records of the decisions AS ACTUALLY SHIPPED (reservation design-17 §9 held them for tickets 27/28, 30, 31; ticket 31/32's handover resolved):
- **0010** — dispatcher presence is a projection of core state, published on transitions, read from pull-only surfaces (snapshot v2→v3 fail-closed contract, no-new-core-state observer timeliness, transition-only publish w/ coalescing skipped, sections partition shared by wrapper sidebar). Vehicle half superseded by 0018/0020 and recorded inside; two capsule-era rationales explicitly re-opened, not re-decided. (`docs/adr/0010-…`; tickets 27/28, commits `f09f19d`/`6874cf2`, merge `400450f`.)
- **0011** — approval answers: Allow / Always allow (this session) / Deny, session-scoped memory, wildcard fence, honest degraded paths; U-D-exact; constant location line superseded by 71's per-producer-kind map, rendering re-hosted by 81 while 30 stays the live answer surface. (`docs/adr/0011-…`; ticket 30, `0e2e9fa`/`7c90a25`.)
- **0012** — restart replays durability, never work (rebuild-before-first-publish ordering, one-time unknown-state honesty, degraded notice; trigger re-based from ADR-0009 activation to the per-session lifecycle bind under 0018/0019; notice rides 57's turn-opening wake, plus 58's bounded redrive). (`docs/adr/0012-…`; ticket 31, `818d03c`.)
- `docs/adr/README.md` index updated for all three; the "reserved" lines in older ADR headers stand as historical filing-time statements.

**No-verbatim-copy review (re-scoped Gate 1/Gate 3 successor) — PASS, zero hits.** Method + evidence: `docs/research/no-verbatim-copy-review-2026-09-19.md`. Grep battery over src/test/client/lib/scripts (codenames, reconstruction basenames, reference protocol tokens, reference fn names, tempting reference prompt phrasings): 0 product hits — only the sanctioned `FORBIDDEN_VOCAB` negative-test fixtures; sole fn-name surface match is our own `composeWakeText`. Tool/locale/module naming traced to PRD §16/CONTEXT glossaries and in-repo authored copy; the reference's literal tool names were never recorded in our docs, so no textual identity with a recorded reference artifact exists. Residual risk = the AGENTS.md human-accepted-risk line (static matching, not semantic similarity; reference prose never quoted in our notes). Pointer comment added on ticket 17 per Gate 3's letter. Not fixed-and-not-ticked here: old Gate 1 (voided by ADR-0018 — stays unticked, superseded), the manual full-copy-read AC (part 1b was targeted grep+judgment over derivation-prone surfaces; a full read of every 27–32 line remains part 2/live-pass work if still wanted under 0018), Gate 2 (no tests run today — docs-only pass).

**Part 2 remaining (NOT done today):** closures for 27–33 + ticket 17 Phase 3 after live pass 5, each with dated comments carrying commit hashes; the moot-closure triage calls below; leftover offline AC ticks; §5-row confirmations are already recorded (2026-09-18 merge comment).

**Closure-readiness assessment for part 2 (verdicts only; no ticket moved):**
- **17 (Phase 3):** blocked until children below resolve — last to close.
- **27:** not ready — implemented + re-based; needs wrapper live presence confirm (pass 5) + the two re-opened rationales (delivered-semantics re-derivation per 0018; native attention markers) decided.
- **28:** not ready — sections proven offline + consumed by shell; needs live confirm + the "Needs-you rationale re-opened" decision.
- **29:** close after pass 5 — verification half done (vehicle-independent); only the first-live firehose confirmation remains.
- **30:** not ready — relay/policy work complete and fenced, but the ticket stays the live answer surface until 69's L1 card-resolve transport lands (69 open).
- **31:** close after pass 5 — offline-complete; trigger re-base landed via 57/58 (both resolved); one live restart-honesty observation wanted.
- **32:** moot-closure candidate — dormant composition proven live (re-pass #2/#3); activated/capsule composition retired at the 78 cutover; shell compositions are the successor surface.
- **34:** nearly ready — boot-graph AC proven live (pass 4); needs the capsule-era composition ACs reconciled with the cutover + one launcher-route boot.
- **46:** moot-closure READY — watch fix proven live (pass 2, AC ticked); remainder mooted by cutover; moot-closure already proposed in-ticket.
- **48:** not ready — capsule AC moot, but the launcher-script drift items are this ticket's real, still-open scope (or an explicit descope call).
- **49:** READY (small ticks first) — live AC ticked both schemes (pass 2); offline AC boxes 1–3 can be ticked from the existing 2026-09-18 offline evidence, then close; shell surfaces verified token-only.
- **78:** close after pass 5 — cutover landed (`94e6127`+`a44084a`); AC 3 disposition re-pointed to 89; live root-election-under-load confirm wanted.
- **84:** moot-verified READY — mechanism proven passes 3+4 (zero inject errors under heavy stress); AC untestable by design post-cutover; closure recommendation already recorded in-ticket for the owner.

No other ticket file moved; Status stays open.

### 2026-09-19 — one-line note

70 chunks 1-3 landed (`d8e2658`, `1a4eb6d`, `fbd4066`; bookkeeping `a55dc99`+closeout) — peer tier OFFLINE-COMPLETE (suite 1101/1101, typecheck + client build green; ticket 70 resolved with the retirement/closeout comments), live two-dispatcher verification (chunk 4: A `send_peer` -> B peer-cue turn, priority interrupts B's non-user turn only, bad-id honest refusal) rides this ticket's live lane.

### 2026-09-19 — closeout batch EXECUTED (tracker-closure agent): 46/49/84/34/32 closed; 29 left untouched — remaining part-2 list below

One commit: `9126909` ("Closeout batch: 46/49/84 (+34/32/29 partial) — evidence-ticked closures"). Every moved ticket was read in full first; boxes ticked only where the recorded evidence met the box's own condition; MOOT-VERIFIED annotations follow the resolved ticket 81 pattern (cutover cites a44084a/94e6127/c437ee8).

- **46 → resolved:** AC 2 ticked from the 2026-09-18 offline gates (711/0/186, RED-verified pin); AC 3 ticked — watch fires + footer flag real (pass 2, shots 10b/13), with the "capsule flips" clause MOOT-VERIFIED (pass 2's dormant-pitch caveat recorded; vehicle retired at the cutover).
- **49 → resolved:** offline boxes 1–3 ticked from the 2026-09-18 record; research-note box re-verified in-tree (`docs/research/dsh-plugin-ui-patterns.md:95`) and the pass-2 token artifacts re-verified (values match byte-for-byte).
- **84 → resolved:** live AC ticked MOOT-VERIFIED (vehicle retired; mechanism proven passes 3+4 — zero `without inject` errors; pass-4 session's only errors were 88's, fixed `d242d18`).
- **34 → resolved:** AC 2 ticked on two recorded boots — the literal `dsh-bot.ps1` executor run never happened, recorded in-ticket (launcher-equivalent overlay boot 2026-09-18 + pass-4 profile boot; pass-4's cited `boot-graph-row.json` is absent from that dir, row content recorded in its README §1 — noted in-ticket); AC 3 ticked (proven live pre-cutover, two passes' screenshots); AC 4 ticked MOOT-VERIFIED (never green as written — 44's pass-2 caveat; frame/toolview vehicle void post-cutover).
- **32 → resolved:** optional `settings.onboarding` box ticked as DROPPED per its own authorization; moot-closure with successor scope in 68/87; blocker discharge (merge `400450f` gates) cited.
- **29: NOT closed, NOTHING added.** Its "if no seam" conditional is already settled inline ("conditional — not triggered: a seam was verified", 2026-09-17 comment); ticking it would falsely claim the box's action was performed. Still waits on pass 5's first-live firehose confirmation.

**Remaining open for part 2 (closeout-map tickets):** 17 (last), 27, 28, 29, 30, 31, 48, 78 — per the readiness verdicts above (27/28/30 need live confirm + re-opened-rationale decisions; 29/31/78 close after pass 5; 48 needs its launcher-drift scope resolved or explicitly descoped). Open tickets outside this map: 68 (on 87's reload re-confirm), 69, 71, 81 (on 69's L1 lane + the settings-card decision), 82, 86, 89. (70 resolved by the peer tier 2026-09-19.)

### Session handover 2026-09-19 (night session end)

**Resolved this session** — `a5344bd..HEAD` "Ticket N resolved" resolutions: 87 onboarding-resuppression, 88 seat-crash, 80 conversation-surface, 79 sidebar-roster, 76 per-session-scoping, 70 peer-tier (offline), 83 spawn-depth, 67 wrapper-vehicle, 77 shell-skeleton, 59 stream-key, 61 liveness, 64 ADR-0018-rebase; plus the closeout batch `9126909` (46 watch, 49 tokens, 84 injects, 34 boot-graph, 32 composition — 32/34/84 moot-verified, 29 deliberately untouched). Resolved set at session end: **67 files** in `Issue-tracker/resolved/` — 01–16 core/FSM/tools/delivery, 18–26 worker/roster/access, 32–42 wrapper + capsule era, 43–47/49 host-half + tokens, 52–64 salvage/governance, 67–88 peer/shell era.

**VERIFICATION DEBT (a verifier pass is owed — these are NOT verified-green):**
- (a) **Owed:** the recovery/closeout batch has never been read by a separate agent — ticket 70 recovery (`a55dc99`) and its chunk closeout (`f09e6e7`), the closure batch 46/49/84/34/32 (`9126909`), 33 part-1 ADRs 0010–0012 + the no-verbatim-copy review (`439404b`, `docs/research/no-verbatim-copy-review-2026-09-19.md`), and tonight's cancelled-agent checkpoint **`d25d6ef`** (69's L1 half + 89's capsule deletion — gates green: typecheck clean, 1044/1044 tests, build:client 161,087 B; the work is frozen not finished).
- (b) **Verified-green (no new pass owed):** 68 (onboarding flow), 69 chunk B (card projections / 81 contract), 81 (cards) — previously verified OK. **87/88/85 fixes** were verified (offline gates + reproductions) **except their live ACs**, which the pass below must close.

**LIVE PASS 5 — PRIME DIRECTIVE (one boot, in this order if cheap):** 88 (seat survives a session-row click; no React #300), 87 (three clean reloads; onboarding delete round-trip), 78 (abdication + HMR paths, main-page harmlessness), 68 AC5 (first-run walk / suppression), 29 (first-live firehose confirmation), 31 (one restart-honesty observation), 69-Q2 (only if L1 is wired — card resolve round-trip), 81 (cards render/resolve), 70 chunk 4 (two-dispatcher `send_peer` peer-cue + priority interrupt + bad-id refusal, if cheap). Recipe + reusable boot scripts: `C:\Users\TZhen\Desktop\dsh-live-pass4-2026-09-19\`. Traps recorded there: the `./` prefix required in the patch row, the `- insert: [{name: ./…}]` object form, `plugin-add` needs `--from-default-profile web`, WMI node-direct detach, and node timers rather than PowerShell timers.

**Remaining open list post-pass-5 (one-line disposition):** 17 — last (Phase 3, after children). 27/28 — live presence confirm + the two re-opened ADR-0010 rationales. 29 — pass-5 firehose only. 30 — waits on 69's L1; else the fallback answer surface decision. 31 — pass-5 restart observation. 33 — this closeout (part 2 = the closures above + the refinement loop). 48 — launcher-drift residual: `-Sync` ahead-refusal exercise still unrun. 68 — pass-5 AC5. 69 — L1 + Q1 (human). 71 — human: seam vs descope. 78 — pass-5 root election/HMR. 81 — settings re-home call + 88 live re-confirm. 82 — human: U-A retry ruling. 86 — fake-vs-host hygiene pass. 89 — asset deletion (offline-complete in `d25d6ef`; ACs unticked).

After pass 5: execute 33 part 2 (dated closures with commit hashes for 17/27/28/29/30/31/48/78 + the outside-map set) and continue the refinement loop. No remote push happened anywhere; session artifacts stay outside the repo under `C:\Users\TZhen\Desktop\dsh-live-*`.

### 2026-09-19 — Gate 2 manual copy read EXECUTED (AC2 ticked) + AC5 confirmed; AC1 stays unticked (voided)

**Scope read.** Every prompt asset, locale string, and user-visible copy line added by tickets 27–32,
plus the copy added by 70/77/78/79/80/81/68 that landed on the same surfaces (78/81/89 named in the
brief; 70/77/79/80/68 read because they own live keys in the same dictionary). Method: (1) mechanical
en/zh parity, (2) a line-by-line read of every added string against its ticket requirement, (3) a
`file:line` verdict per string. No reference material was opened; design-17 §7 was the comparison
source for the 27–32 drafts.

**1. en/zh parity — PASS, mechanical.** One locale dictionary ships (`src/client/overlay.ts:115`,
registered once at `src/client/index.ts:236`; no second dictionary exists anywhere in `src/`).
`validateLocaleDictionary` (`src/client/overlay.ts:421-454`) asserts both faces present, every value a
string, and identical key sets. Executed directly against the shipped module:

```
en keys: 93   zh keys: 93
validator problems: []   en-only: []   zh-only: []
```

Counts: **93 en keys, 93 zh keys, 0 problems** (the 2026-09-18 merge record's 49 = 49 predates
tickets 47/68/70/77–81; ticket 89 deleted the capsule-era keys from BOTH faces, so parity held through
the deletion). Cross-check beyond the validator: every literal `t("…")` key referenced in `src/client/`
resolves in the dictionary (23 literal keys, 0 missing); the remaining 70 keys are referenced through
key constants (`settings-card-store.ts:85-98`, `conversation.tsx:161-176`, `approval-pane.tsx:85-93`,
`onboarding.ts:146-167`, `toolviews.ts:90+`, `actions.ts:175-181`) — all present in both faces.

**2. The read — verdicts (en line cited; zh twin on the line after each en block).**

*Tickets 27/28 — roster/panel copy (`src/client/overlay.ts:117-134`):* `roster.title` "Workers" :117
PASS · `roster.empty` "No workers yet. Ask the dispatcher to start some." :118 PASS (plain language,
no invented state) · `roster.unavailable` "Worker status is unavailable right now." :119 PASS (states
unavailability without a remedy it cannot offer — **consistent with ticket 82's ruling: no retry
affordance, no reconnect wording anywhere in the dictionary**) · `roster.loading` :120 PASS ·
`roster.blocked.{tool,credential,network,filesystem,other}` :121-128 PASS (names only — the credential
variant says "use the credential \"{target}\"", never a value; matches design-17 §7 drafts) ·
`roster.landed` "Result ready — not delivered yet" :129 PASS (the delivered flag, stated exactly) ·
`roster.activity.toolcalls` :130 PASS · `roster.section.{active,needs-you,finished}` :131-133 +
`roster.finished.count` :134 PASS (all four match the §7 drafts verbatim).

*Ticket 29/80 — streaming/conversation copy (`src/client/overlay.ts:214-229`):* `shell.conv.waiting`
"History has not arrived for this session yet." :214 PASS · `shell.conv.unavailable` :215 PASS ·
`shell.conv.empty` :217 PASS — **the three are distinct facts, which is the AC's own requirement**
(unknown ≠ unavailable ≠ empty) · `shell.conv.more` :218 PASS · `shell.conv.role-user/assistant`
:219-220 PASS · `shell.conv.working` "working…" :221 PASS · `shell.conv.interrupted` "(interrupted)"
:222 PASS (carries the host transcript's own `interrupted` flag, `conversation-store.ts:375`; it is a
transcript fact, never a claim about a worker's outcome) · `shell.conv.attachment-only` :223 PASS ·
`shell.conv.tool-running/tool-failed` :224-225 PASS · `shell.conv.send/sending` :226-227 PASS ·
`shell.conv.no-channel` "No send channel is reachable in this runtime." :228 PASS ·
`shell.conv.send-failed` "The send failed — the message was not delivered." :229 PASS (no optimism, no
retry).

*Ticket 30 — approval copy (`src/adapter/access-prompt.ts`):* `ACCESS_PROMPT_ALLOW` "Allow" :84 PASS ·
`ACCESS_PROMPT_ALWAYS_ALLOW` "Always allow (this session)" :91 PASS (**U-D exact** — the parenthetical
is the scope claim and the code keeps it: session rows are cleared per session,
`src/plugin.ts:571-574`, and the wildcard fence degrades an always-shaped answer to a one-shot allow,
`src/adapter/resolve-command.ts:180-187`) · `ACCESS_PROMPT_DENY` "Deny" :94 PASS ·
`ACCESS_PROMPT_DENY_DETAIL` :100 PASS (worker-facing, deliberately plain) · `APPROVAL_LOCATION_LOCAL`
"Runs on your computer." :110 PASS · `APPROVAL_LOCATION_REMOTE` :120-121 PASS — **unreachable today
and honestly labelled as such** (ticket 71's gate: no remote-exec face exists; the map resolves the
remote line only for the two reference worker kinds, `:131-161`, so no shipped ask can claim remote) ·
`APPROVAL_EXPIRED_COPY` :170-171 PASS (deny-by-default stated as fact) · `APPROVAL_SECRET_STORED_COPY`
:178-179 PASS (names-never-values kept: the string names the credential, carries no value) ·
`approvalDetailOmissionMarker` "… [+{count} more characters]" :188-189 PASS (the clamp is visible
rather than silent; clamp bound `:185`).

*Ticket 31 — restart honesty:* `RESTART_NOTICE_HEADING` / `RESTART_DEGRADED_NOTICE`
(`src/adapter/restart-notice.ts:26`, `:33-35`) PASS — "Nothing was restored and nothing was replayed"
is the honest degraded answer · unknown-state line `:53-62` PASS — states unknown, "nothing was
replayed", and (ticket 59's added clause) that the stream keys are still held, so the refusal that
follows reads as the invariant, not as a bug · restored line `:72-75` PASS. All four are
dispatcher-facing (the agent narrates for the user), and none claims a stopped worker produced a
result. Policy rules: `src/core/policy/prompts.ts:95` ("…Never claim a stopped worker produced a
result.") PASS and `:97` (no board/milestone view) PASS — both verbatim from design-17 §7's drafts,
and both are the only milestone/board mentions in `src/` (grep: 2 hits, the rule + its comment).

*Ticket 32 — activation copy (`src/adapter/activation-command.ts`):* `ACTIVATION_PRESENCE_HINT`
:36-37 PASS — names where presence lives and sets the delivery expectation; it is the ONE string kept
in lockstep with the dictionary (`src/client/overlay.ts:154-155` en + zh `:309-310`, asserted by
`test/composition-polish.test.ts`) · `DISPATCHER_START_SUCCESS` :40-42 PASS · `…_ALREADY_HERE` :45-46
PASS · `…_NOT_TOP_LEVEL` :55-56 PASS · `…_UNRESOLVED` :60-61 PASS (refuses, never guesses).

*Tickets 77/78/79 — shell chrome (`src/client/overlay.ts:197-209`):* `shell.title` :197,
`shell.sidebar.label` :198, `shell.empty` :199, `shell.noselection` :200, `shell.conversation.pending`
:201-202 PASS (the last is the honest no-seat fallback: since ticket 80 the pane is a host seat, and
the line shows only when a composition mounts the shell without it) · `shell.row.{working,needs-you,
finished}` :203-205 PASS (counts, formatted) · `shell.row.presence-unavailable` :206 PASS (**the
ticket-82 ruling's live surface**: a stale/corrupt/absent mirror renders this chip — no retry, no
reconnect banner; pinned by the shell's own "failure states are retry-less" test) ·
`shell.row.copy-id` :209 PASS (ticket 70; the id is what a peer addresses).

*Ticket 68 — onboarding (`src/client/overlay.ts:238-258`):* five beats + `next`/`done`/`skip`/`step`
+ `save-failed` :238-258 PASS. Spot-judged: `intro.body` "This window is the dispatch shell…" PASS
(describes the shipped frame, no account/sign-in beat — U-A gap honoured) · `background.body` PASS
(single worker kind only, no background-command/remote-job promise — C15) · `tools.body` PASS
(approval gate stated as fact, no always-allow persistence claimed) · `first.body` PASS (user-driven
creation only — U-G) · `save-failed` :257-258 PASS (one honest line, retry-less). Note recorded rather
than glossed: `handoff.body`'s "This introduction does not repeat." is an absolute, and the
`save-failed` line is the qualifier for the case where it is not true; both render on the same pane,
so the pair is honest. No edit made.

*Ticket 81 — approval-card chrome (`src/client/overlay.ts:268-279`):* `shell.approval.target` :268
PASS · `secret-promise` :269-270 PASS · `unavailable` :271-272 PASS (a pending card with no resolve
seat says so instead of offering dead buttons) · `no-channel` :273-274 and `failed` :275-276 PASS
(both end "nothing was changed" — honest, retry-less) · `shell.dispatch.gating` "Gate" :279 PASS
(label only; the value renders the projection's frozen vocabulary verbatim) · `submitted` :277-278
**FLAG (low)** — see below.

*Ticket 70 — peer copy (`src/client/overlay.ts:146-147`, `src/core/policy/prompts.ts:39`):*
`toolview.field.peer` "To session" / `toolview.field.priority` "Priority" PASS (labels only; the peer
message body never renders on the row) · `SEND_PEER_TOOL` description PASS ("Failed sends are reported
and dropped — there is no queue and no retry." is true of the shipped path:
`src/core/tool-results.ts:266-278`).

*Ticket 89 — deletions:* the capsule-era keys (38/39/40/41/42 blocks) are gone from **both** faces in
the same commit, so the key sets stayed identical; verified by the 93 = 93 count above and by the
absence of any orphaned `t("…")` reference (0 missing keys).

**3. FLAGs (2, both low severity; neither fixed — see why per item).**

- **FLAG-1 — `shell.approval.submitted` over-promises a card update.**
  `src/client/overlay.ts:277-278`: "Answer sent — this card updates when the dispatcher confirms."
  The shipped relay feed does **not** carry settled states: `src/client/approval-feed.ts:12-19` says a
  card "LEAVES when the relay settles it", and resolved/expired card states ride notices "which this
  channel does not carry". So today the card is *removed* from the pending list, not updated.
  **Recommended fix (not applied):** reword to a claim true on both paths — e.g. "Answer sent — the
  card clears once the dispatcher has the answer." — *or* wire the notice feed the store already
  supports (`projectAccessAskCards` settles cards from notices, `src/client/approval-cards.ts:182-207`,
  pinned by its own tests) so the existing wording becomes true. **Why not fixed here:** the two fixes
  are not equivalent (copy change vs feed change) and the store's notice projection is shipped, tested
  code — the copy describes the designed settle path; choosing between "reword" and "wire the feed" is
  ticket 69/81's call, not a copy-edit. A copy change made here would silently pick one.

- **FLAG-2 — the ticket-30 approval strings are en-only; no zh face exists for them.**
  The five user-visible approval strings (`Allow`, `Always allow (this session)`, `Deny`,
  "Runs on your computer.", the expired copy, the secret-stored reassurance, the omission marker)
  live only as English constants in `src/adapter/access-prompt.ts:84-189`; grep for their design-17 §7
  zh drafts returns zero hits anywhere in `src/`. They surface to the human through
  `ctx.userQuestions.ask` (`:245-247`), so a zh user sees English approval copy.
  **This is NOT a violation of the parity contract as written** (the contract is over the locale
  dictionary, which is 93 = 93 and passes), and it is not introduced by 27–32 — ticket 30 shipped it
  this way. Recorded because AC2 asks for a real read, and a mechanical parity check cannot see it.
  **Recommended fix (not applied):** carry zh beside each constant (or route the strings through the
  locale face) when the prompt pathway gains a zh seat; note it on ticket 30's supersession record.
  **Why not fixed here:** it is a localization feature, not a copy defect — the host prompt pathway
  renders server-side with no zh seat, so a two-line constant pair would be dead text.

**4. Boundaries observed, recorded not ticked.** (a) The copy is honest about the code everywhere;
where the *code* still carries the pre-ADR-0018 feature flag (`src/plugin.ts:54` `enabled`, and the
settings card that edits it, `src/client/overlay.ts:184-190`), the card's wording states the flag's
real behaviour ("it applies to new chats. The chat you are in keeps the flag it started with") — PASS
as copy. The flag's existence against ADR-0018's "no flag, always-on" is a code/architecture item with
no removal ticket found in the tracker; it belongs to the re-base's remaining work, not to this gate.
(b) No string in the dictionary or in `src/` promises a roster retry affordance, a reconnect banner,
or a "stopped" claim for a worker that produced a result — the ticket-82 ruling's wording check.

**5. AC5 — `§5 conflict markers honored` — CONFIRMED, ticking.** The confirmation genuinely exists:
the 2026-09-18 comment on `Issue-tracker/open/17-…md` (rows 1–8 spot-checked PASS, with row 4's
required "default-activation not adopted by choice" note) is the review comment AC5 asks for, and it
was re-verified against today's tree, not just cited:

- row 1 **no stop control** — PASS. `src/client/shell.tsx:46` ("the shell never spawns, steers, stops,
  or sends"), `src/client/conversation.tsx:20` ("NO stop/cancel"), and no stop affordance in any
  client surface; stops stay conversational (`src/core/policy/prompts.ts:95`).
- row 2 **no todo board** — PASS. `src/client/panel.tsx:99,200-201`: a muted `__row-todo` chip only.
- row 3 **no milestone surface/prompt implication** — PASS. The only mentions in `src/` are the
  prohibitive rule and its comment (`src/core/policy/prompts.ts:96-97`).
- row 5 **session "always" rows cleared** — PASS. `src/plugin.ts:571-574`
  (`clearSessionAccessPolicy(sessionId)` on deactivation) plus `:673` (all sessions on unload).
- row 6 **no second producer kind** — PASS. `src/core/roster-snapshot.ts:120-121,373` admits exactly
  `kind: "worker"` and rejects others at parse. Note for accuracy: the wake bus's *turn sources* now
  include `peer`/`timer` (`src/core/wake-bus.ts:14-28`) — that is C15-sanctioned (a peer message is a
  wake source into the existing pipeline, not a new roster producer kind) and does not touch row 6's
  subject, which is the ledger/panel producer vocabulary.
- rows 4/7/8/9 — as recorded 2026-09-18 (row 4's note stands; 7 and 8 are standing/future-triggered;
  9 carries no revisit marker).

**AC dispositions from this pass.** **AC2 — ticked** (read executed, parity mechanical and clean,
FLAGs recorded with recommendations; no fix applied, so nothing to re-verify). **AC5 — ticked** (above).
**AC1 — left UNTICKED and superseded** (voided as a ship gate by ADR-0018; the no-verbatim-copy review
is its successor and is already recorded, 2026-09-19). **AC6/AC7 — untouched** (merge and closure
work; the merge itself landed `400450f` long before this pass). Gate 2 (AC3) was not run as a new
pass — no code changed here; the standing counts on this branch are `npm test` 1044 pass / 0 fail /
256 suites, `npm run typecheck` clean (both configs), both re-run for the record.

### 2026-09-19 — AC6 ticked: merge landed (`400450f`) + part-2 merge train landed; post-merge gates green

AC6's substance was already satisfied on 2026-09-18 by the `--no-ff` merge at **`400450f`** with the
post-merge gates recorded above: `npm ci` clean from the lockfile (0 vulnerabilities), `npm test`
**701 pass / 0 fail / 185 suites**, `npm run typecheck` clean on both configs, `npm run build:client`
green (`client/index.js` 64,658 B). The box was deliberately left unticked then. It is ticked now,
with two additions:

1. **Part-2 merge train landed on main** (all `--no-ff`, explicit-path staging, no rebase):
   `wt/48` → **`7ec5c1f`** (ticket 48 resolved, ticket-file only); `wt/docs` → **`2cad4ce`**
   (tickets 82 + 71 resolved, ticket 33 Gate-2 copy read + AC2/AC5, new ticket 90 restart-honesty);
   `wt/86` → **`4add534`** (fake-vs-host contract inventory + 5 HIGH alignments); `wt/89` →
   **`d0bd81f`** (ticket 89 resolved: capsule-retirement read-through, stale-comment fixes).
   No manual conflict resolution was needed: `test/client-shell-mount.test.ts` (touched by both
   wt/86 and wt/89) auto-merged, and the result was diff-verified against both branch tips — wt/86's
   corrected keyed/list collision wording (host `SlotCore.register` text) and wt/89's dead
   `ClientLayoutLike` import removal + structural layout typing are both present.
2. **Ticket-number collision resolved at the train:** wt/86 and wt/docs both filed a ticket 90;
   the host-registry one is renumbered **90 → 91**
   (`Issue-tracker/open/91-host-registry-duplicate-throws-unmodeled-in-fakes.md`) with its header
   and every ticket-86 inventory reference updated; the restart-honesty one stays at 90.
   `Issue-tracker/` now has no duplicate ticket numbers.

**Gates re-run on merged main (2026-09-19, offline, this tree):** `npm test` **1049 pass / 0 fail /
257 suites** (0 cancelled/skipped/todo); `npm run typecheck` clean (`tsconfig.json` and
`tsconfig.client.json`); `npm run build:client` green (`client/index.js` 161,087 bytes).
`npm ci` was NOT re-run for this train: `node_modules` is junction-shared with five live agent
worktrees, so the 2026-09-18 clean-install result stands as the recorded evidence.

**Still open on this ticket:** AC1 (left unticked, superseded — see the previous comment), AC3
(Gate 2 in the worktree, unrun as a separate pass), AC7 (close tickets 27–33 + ticket 17 Phase 3
with dated comments carrying commit hashes).

### 2026-09-19 — live pass 5, Session A record: 78 + 88 + 68-AC5 + 87 live lanes passed (zero LLM); the three 78 clauses not run recorded; AC7 still NOT ticked

Evidence root: `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-19\evidence\A\` (driver
`.out.json` per command, `status-after-*.json` console tallies, `reqlog-A3-walk.json`, settings
yaml copies, `web-profile-before.md5` / `web-profile-after.md5`, `teardown-port-and-pids.txt`);
screenshots under `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-19\shots\`. Real dsh host boot
(`@deepseek-ai/dsh@0.1.5-rc.1`, throwaway `multitask` profile, port 8877), Playwright headless
chromium. **Zero LLM turns** and zero pageerror/console-error throughout (every status tally
`log: []`); clean teardown (no LISTENING line, all five pids gone); stock `web` profile
byte-identical (`web-profile-before.md5` / `web-profile-after.md5`).

**Passed in Session A:**
- **78 → resolved** (ticket commit `cd4caeb`): frame swap confirmed (`78-03-frame.json.out.json` —
  shell in the `root` slot, `stock:0`, `failLoud:false`; `status-after-78-boot.json` `log: []`),
  full re-apply on reload confirmed (`78-06-after-reload.json.out.json` identical;
  `status-after-78-reload.json` `log: []`), seats in the elected frame confirmed (onboarding
  `A3-03-probe-beat1.json.out.json` / `A3-08-probe-settled.json.out.json`; roster
  `88-01c-rows.json.out.json`; conversation `88-04-seat.json.out.json`).
- **88:** live re-confirm — clicking the seeded non-empty row `Interastral-Peace-Casino` opened
  `.multitask-dispatcher-conv` with `shell=1, conv=1, selectedRows=1, rootChildIsShell=true,
  stock=0` (`88-04-seat.json.out.json`); zero `Minified React error` / `slot entry crashed`
  anywhere in the Session A evidence (`status-after-88-rowclick*.json` all `log: []`); a second
  row and a flip-back also clean.
- **68 AC 5 → resolved** (ticket commit `3cd6cd7`): first-run walk post-cutover inside the
  elected frame, `intro → background → tools → first → handoff` → settled, `saveFailed:0`
  (`A3-03`…`A3-08` probes; `status-after-A3-walk.json` `log: []`). Honest note: the walk window
  was reopened by clearing the persisted seen record through the host's client-visible
  `settings/update` RPC (`A3-clear-seen.json.out.json`).
- **87 → live AC ticked** (ticket commit `5d0e6ac`): three consecutive reloads all `settled`
  (`A4-01c-probe.json.out.json`, `A4-02c-probe.json.out.json`, `A4-03c-probe.json.out.json`),
  delete round-trip re-showed the flow (`A4-11-probe-after-delete.json.out.json`) and the record
  was restored (`A4-14-restore-seen.json.out.json`).

**Not run in Session A (recorded, not claimed):** 78's `selectPanel`/main-page harmlessness (no
driver-reachable seam; no shipped caller post-cutover/89), fallback-on-crash (proven pass 4 by a
real crash; not re-inducible now that 88 is fixed), live unload/HMR (no unload affordance
exists). Session A covered 78/88/68-AC5/87 only — the rest of the pass-5 list (29, 31, 69-Q2,
81, 70 chunk 4) is not part of this record.

**AC7 remains unticked and this ticket stays open** — the closure sweep (17/27/28/29/30/31/48 +
the outside-map set, dated comments with commit hashes) is the later part-2 step; this comment
only adds the pass-5 trail the umbrella was owed.

### 2026-09-19 — session wrap (overnight autonomous run): handover to the next session

- **Landed and resolved:** 48, 68, 71, 78, 82, 86, 87 (live re-confirm), 89,
  90, 91, 92, 93, 94; **69-Q1 ruled** (posture default stays EMPTY; overnight
  dispatched ruling, reversal path recorded on 69). Merge shas to cite (from
  `git log --oneline -25`): `a3e54bf` (wt/91 → ticket 91 fakes),
  `b01f758` (wt/90 → ticket 90), `61ddf61` (wt/69l1 → the 69-L1 composition
  pin), `2ef2b43` (wt/q1 → 69-Q1 ruling), `bdf6a0e` (wt/pipe → tickets 93+94),
  `55e6847` (wt/send → ticket 92), `9b5da8a` (wt/hygiene → packaging: MIT
  LICENSE + `prepack` + repo metadata, retro ticket 95).
- **Live pass 5 status:** Session A ALL PASS (78 frame/re-apply, 88 seat click
  no React #300, 68 AC5 first-run walk, 87 three clean reloads + delete
  round-trip) — evidence `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-19\evidence\A\`.
  Session B exposed 3 live bugs (composer send threw; roster channel never
  published — `settings.installSection` returns void in the real host; shell
  mirror reader never fed) → fixed as tickets 92/93/94, merged to main at
  `55e6847` (1103 tests / 269 suites / 0 fail, typecheck clean, build:client
  ~164,898 B on disk).
- **92/93/94 live verification: NOT ATTEMPTED (budget exhausted after recon
  only — no build, no boot, no browser against the fixed code). Evidence root
  `C:\Users\TZhen\Desktop\dsh-live-fixes-2026-09-19\` contains reference
  copies of the pass-5 harness only, NO evidence. Do not treat 92/93/94 as
  live-green.**
- **Next session's first steps:** (1) rebuild (`npm run build && npm run
  build:client`) then `plugin --profile multitask remove
  dsh-multitask-dispatcher` + re-add — the `multitask` profile's installed
  copy is STALE (pre-fix); the plain re-add reports "Already up to date" and
  does NOT refresh, remove+add is required; verify `diff -rq` repo lib/ vs
  profile copy is empty. (2) Boot per
  `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-19\README.md` §2 (port 8877,
  object-form patch row, kill timers armed at launch — mandatory per
  AGENTS.md). (3) Live-verify 92 (composer send delivers; the fixed idiom is
  `sessions.scope(id).get("conversation")`, NOT a property read), 93
  (`settings/describe` now shows `roster.*` keys; cards render), 94 (rows
  show `data-dispatcher="true"`, presence chips live). (4) Then Session B
  (81 cards, 69 L1/L2, 30) and Session C (27/28 presence, 29 firehose,
  31 restart, 70 chunk-4 peer) per ticket 33's pass-5 directive. (5) Then AC7
  closures + ticket 17 last.
- **Driver notes for the next agent:** driver protocol verbs
  `goto/screenshot/wait/count/text/attr/click/typetext/press/sleep/js/status/close`;
  commands are `{...}.json` → `....out.json`, strictly serialized; `js`
  results arrive JSON-string-encoded (double-parse); `tools/cmd/` is wiped at
  driver start so copy artifacts out. If tool output gets truncated in long
  reads, read in ~15-line windows. Zero-LLM for 92/93/94 checks; trivial
  tasks only if a spawn is needed.
- **Unfiled audit backlog** (from a read-only audit; ticket when picked up):
  no CI; no lint/format; a set of possibly-dead exports (incl.
  `SHIPPED_CLAIMED_TOOLVIEW_KEYS` and `validateLocaleDictionary` — wire up or
  delete, do not blindly delete); README thin vs PRD; no CHANGELOG; the
  `test` script compiles everything under the client tsconfig (possible
  masking of server-side type errors).

### 2026-09-19 — evidence-folder cleanup (desktop)
At the human's request the superseded live-pass artifact folders were deleted from the Desktop: `dsh-live-pass2-2026-09-19`, `dsh-live-pass3-2026-09-19`, `dsh-live-repass3-2026-09-18`, `dsh-live-ticket45-2026-09-19`, `dsh-live-fixes-2026-09-19` (~96 MB; the fixes folder held harness recon copies only, never evidence). Any ticket citation pointing into those five folders is now a dead path — the recorded results stand as written, but the raw artifacts are gone. Still on disk and current: `C:\Users\TZhen\Desktop\dsh-live-pass4-2026-09-19\` and `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-19\` (boot recipe + Session A evidence; see the pass-5 handover above).

### 2026-09-20 — independent verification pass (read-only) clears the standing verification debt; recorded by overnight bookkeeping run (W0)

The 2026-09-19 handover's "VERIFICATION DEBT" item (a) is discharged by an independent read-only
verification pass (2026-09-20, separate agent from the original executors):

- **Closure batch `9126909` (46/49/84/34/32) re-read:** all 35 cited commit hashes resolve, and the
  in-tree artifacts confirm — `test/client-theme-tokens.test.ts`,
  `docs/research/dsh-plugin-ui-patterns.md:95`, `docs/surfaces.md`, `dsh.client.inject` in
  `package.json`, 8× `settingsScope` in `src/client/index.ts`.
- **ADRs 0010–0012:** verified coherent with tickets 27/28/30/31 as described; status lines intact;
  partial supersessions self-recorded.
- **Frozen WIP `d25d6ef`** (69 L1 half + 89 deletion): confirmed an **ancestor of `main`** (not
  stashed/dangling); its `src/client/approval-feed.ts` and `src/adapter/resolve-command.ts` are
  byte-identical with `main` — the "apparently landed" list is landed.
- **Gate 2 substance reproduced on `main`:** `npm run typecheck` clean on both tsconfigs;
  `npm test` **1103 assertions passed / 0 fail / 269 suites** — the handover's 1098/267 baseline is
  stale (the pass-5 Session-B record already carried 1103/269 at `55e6847`).

**Residuals (unchanged, recorded):** (1) claims citing the five deleted Desktop evidence folders
(`dsh-live-{repass2,repass3}-2026-09-18`, `dsh-live-pass2/pass3-2026-09-19`, `dsh-live-fixes`) rest
on the recorded text only — raw artifacts are gone (see the 2026-09-19 cleanup note above);
(2) the RED-verified pins (46's 7-fail revert, 49's 2-fail) were not re-run — accepted on the
recorded evidence. Bookkeeping executor's own spot-checks this date corroborate the mechanical
claims (ancestor check, byte-identity diff, file/line/count greps); the full re-read is the
verification pass's. AC1 stays unticked (superseded); no box moved; ticket stays open.

### 2026-09-20 — live pass 5, Session B-1 (W10, zero-LLM): 93 + 94 LIVE-VERIFIED; 92 partial (wiring + composer live, delivery NOT-COVERED-zero-LLM)

Evidence root: `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-20\session-B1\` (README maps every
artifact to the AC it proves; per-command `.json` → `.out.json` pairs in `session-B1/driver/`).
Boot per the W9 record (`throwaway multitask` profile, port 8877, WMI-detached); profile copy
md5-verified against repo lib/client pre-boot (`b3089dc3…`/`5c9e10f7…` — all three fixes in the
served code). **Zero LLM contact by construction:** no `session/prompt`, no composer submit, no
spawn, no steer; the only state-changing call was `commands/execute` of `/dispatcher-start` — a
host command (gate + policy inject + publish, no model turn), whose registration was verified via
`commands/list` BEFORE any interaction (token-incident guard). Page error log `log: []` throughout
(`w10-17-status`). Kill timers armed at launch (30-min internal + 45-min WMI backstop + 20-min
driver wrapper), all killed at teardown; port 8877 free; node inventory identical to pre-flight;
stock `web` profile byte-identical (md5 + mtimes). Full teardown record:
`session-B1/teardown-port-and-pids.txt`, `orphans-and-teardown-w10.txt`, `webprofile-verdict-w10.txt`.

- **93 → LIVE-VERIFIED (document level).** A/B on one boot: `settings/describe` PRE-activation
  shows only `onboarding/enabled/accessRequestTimeoutMs`, **zero `roster.*` keys, revision 0**
  (`describe-01-baseline.json`); after the RPC activation (`w10-05-activate` — full
  `DISPATCHER_START_SUCCESS` copy), describe shows **`roster` AND
  `roster.session-cf5249cf-0bc6-4e8f-9360-c82f06218cfc`, revision 0→3**
  (`describe-02-after-activate.json`, `w10-06b-mtsum`), each a `schemaVersion:4` snapshot with the
  `dispatcherSessionId` set and 1 restored worker row (the `rebuildAndNotice` durability-rebuild
  row from pass-5 Session A markers). The channel therefore attaches through the fixed
  `settings.register` claim (`profile lib/adapter/settings-section.js:72` confirmed pre-boot) and
  publishes BOTH mirror families — the exact defect this ticket fixed (the void `installSection`
  return never yielded a scope). The 2026-09-19 Session B record (same session id, same checks,
  zero keys at every point in time) is the before-picture; tonight is the after.
- **94 → LIVE-VERIFIED (rows + presence + replay).** Pre-activation all 8 sidebar rows
  `data-dispatcher="false"` / `data-presence="unavailable"` (`w10-03-frame2` — the Session B bug
  surface reproduced honestly); post-activation the activated row flips **`data-dispatcher="true"`**,
  **`data-presence="needs-you"`** with live chips `needs-you=1 个需要你` +
  `waiting=结果已就绪，尚未送达` (the `roster.landed` copy), and the dispatcher row sorts FIRST
  while the other 7 stay honest `unavailable` (`w10-07-rows`). After a full page reload the fresh
  mount still replays the flag (`w10-13-rows-replay`: `disp:"true"`, row first); presence then
  reads `unavailable` because `publishedAtMs` exceeded `ROSTER_STALE_WINDOW_MS` (60 s) — the
  documented one-stale-rule (`src/client/shell-store.ts:241-248`), recorded so it is not misread
  as a regression. Served-bundle detector: the combo route (`/plugins/??dsh-multitask-dispatcher/…`,
  fetched in-page — curl gets the SPA fallback) carries **`applySessionMirror(` ×3** (pre-fix
  bundle: exactly 1, the definition) + `createShellMirrorFeed`/`sessionMirrorsFromChannelValue`
  call sites (`w10-15-bundle2`). Screenshot: `w10-shot-sidebar-after-reload.png`.
- **92 → PARTIAL: wiring + composer verified live; the delivery click itself is
  NOT-COVERED-zero-LLM (needs Session B-2 with one trivial task).** Verified live: the served
  bundle carries the scoped service-method boundary — **`scopedConversation` ×3 and
  `get("conversation")` ×2** (`w10-15-bundle2`) — and the dead property read is gone; the row
  click opens the conversation seat in the elected frame with composer TEXTAREA + send button,
  send disabled on empty input, no React error (`w10-09-seat`); a draft typed WITHOUT submitting
  enables send and never reaches the transcript (`w10-10-type`, `w10-11-draft`). What a live
  click-send would add (the turn actually landing in the host sink) requires a model turn and is
  deliberately left to B-2 per the plan's zero-LLM line for this session.
- **Hygiene for the next lane user:** after the observations, `settings/update` nulled BOTH roster
  keys (accepted, revision 3→4; `describe-03-after-cleanup.json`), so no stale mirror persists in
  the profile document; the dispatcher session `cf5249cf…` is NOT activated post-teardown
  (activation is in-memory). W11 instructions at the end of `session-B1/README.md` (boot recipe,
  timer syntax, stale-window nuance for reading L2 markers).

Files 92/93/94 are already resolved and do not move; this comment adds the live trail only. No AC
box on 33 is ticked by this session.

### 2026-09-20 — live pass 5, Session B-2 (W11, two trivial tasks): 92 delivery LIVE-VERIFIED; 69 L1/L2 + 81 cards + 30 UX NOT-TRIGGERED — no access ask ever parked; two findings recorded for the sweep/W12

Evidence root: `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-20\session-B2\` (README maps every
artifact to the AC it proves; per-command `.json` → `.out.json` pairs in `session-B2/driver/`;
screenshots in `session-B2/shots/`). Boot per the W9 recipe on the throwaway `multitask` profile,
port 8877, WMI-detached; profile copy md5-verified pre-boot against HEAD `cf315e8` (`b3089dc3…`
lib / `5c9e10f7…` client); kill timers armed at launch (30-min internal + 45-min WMI backstop +
20-min driver wrapper + 18-min self-exit), all cleared at teardown. Page error log `log: []`
through the whole session including both task flows. Teardown: dsh tree killed, port 8877 no
LISTENING line, zero playwright browsers, profile document left clean (roster keys nulled,
revision 11→12), stock `web` profile byte-identical (md5 AND mtimes).

**Task budget: 2 tasks** (1 authorized + 1 amendment recorded in
`session-B2/task-budget-w11.txt` BEFORE the second send — the first task's transport was green but
produced zero approval-flow coverage; the PLAN's "genuinely requires a second" clause was invoked
honestly). Each task = one composer send → one dispatcher turn → one worker spawn → one worker
turn. Prompts/outputs tiny.

- **92 → LIVE-VERIFIED (the delivery click W10 could not cover zero-LLM).** 787-char draft typed,
  send enabled (`w11-10b-draft2`); click send → input cleared 787→0 and the user message LANDED in
  the host sink and renders in the transcript (`w11-13b-state` `hasTask:true`); the dispatcher LLM
  turn ran from that delivery (`todo_write` + `spawn_worker` rows, worker `5d3b0648…`), the worker
  completed, and the result was DELIVERED — roster truth `status:"completed"`, `delivered:true`
  (`w11-17-poll2`), transcript narration "Probe B2 is done and reported" (`w11-18-conv`). Task 2
  identical (`w11-28-state2`, worker `30ba1bf1…`). Served bundle carries `scopedConversation` ×5
  and `dispatcher-resolve` ×1 (`w11-32-bundle`). This closes 92's one open clause: send → turn →
  worker → delivery, end to end, live.
- **69 L1 → NOT-TRIGGERED (no card ever existed).** Both workers were explicitly instructed (task
  2: as their FIRST action, with an echo-back refusals rule) to call `request_access` once;
  neither did, and neither reported a refusal. `settings/describe` showed `pendingAsks: []` at
  every poll (`w11-15-cardpoll`, `w11-17-poll2`, `w11-30-cardpoll2`) while the channel demonstrably
  published (revision 0→1→6→11). No pending ask ⇒ no card, no `/dispatcher-resolve` round-trip
  (the command was registered — `w11-03-cmdlist`, token guard — but never exercised). The FEED
  half is code-level live: served bundle carries `applyRelayTruth` ×3,
  `createApprovalRelayFeed` ×2, `pendingAsksFromChannelValue` ×2 (`w11-32-bundle`).
- **69 L2 → NOT-TRIGGERED.** Nothing ever waited. The dispatcher row's `needs-you` + `waiting`
  chips seen tonight are the pass-5 landed-undelivered worker's `roster.landed` marker
  (d54d583b) — deliberately NOT read as a blocked-on-ask marker (B1 handover note).
- **81 → NOT-TRIGGERED (access-ask cards) + FINDING 2 (dispatch cards did not render).** No
  pending ask ⇒ no access-ask/secret-ask card (honest absence held). AND: zero
  `[data-card-kind]` elements after TWO settled `spawn_worker` records with delivered results
  (`w11-23-dispatchcard`) — the worker-dispatch card projection (`projectDispatchCard`) never
  produced a card from a live settled spawn; either the live host event shape does not carry the
  JSON tool-result record the reduction parses (`conversation-store.ts:404-424`) or the reduction
  never runs live. `gated: true` therefore unobservable tonight (posture is EMPTY per the Q1
  ruling; a live ungated spawn was the expected shape). **Settings-card re-home: ruled** — see the
  dated agent ruling on ticket 81 (card STAYS a shipped-settings entry; subject to human
  reversal; box left for the sweep).
- **30 → NOT-TRIGGERED live.** No ask ever parked, so the card/prompt answer surface never fired;
  the 345-char clamp-bait reason was never consumed. Ticket 30's UX remains offline-verified only;
  nothing on it was contradicted.
- **FINDING 1 (needs triage — blocks 69 L1–L4's live lane and 13/23's relay loop at the
  worker-ask step): the worker-side `request_access` tool appears not to reach the live worker
  toolset.** 3/3 instructed workers skipped the call across two task shapes, two workers, and two
  sessions (the third data point is pass-5 Session A's "pass5 ask" worker, same instruction
  shape, restored row visible tonight). `request_access` registers on the plugin-level global
  `ctx.tools` (`src/plugin.ts:466-491`, whose comment asserts workers "resolve it through the
  global layer"), while the dispatcher's five tools register per-agent via `agent.ctx.tools`
  (`:520-528`) and demonstrably reach the dispatcher. Alternative explanation: three independent
  model non-compliances. Not distinguishable post-hoc in this lane (no worker-toolset listing
  surface found; firehose rows carried no activity after completion). Recorded for the sweep /
  a code owner to pin offline; W12 (L3/L4) does NOT depend on it (the dispatch seam rides
  `spawn_worker`, which does reach the dispatcher).

No AC box on 33, 69, 81, or 30 is ticked by this session; no ticket file moves. Dispositions
belong to the W14 sweep with the evidence review.

### 2026-09-20 — live pass 5, Session B-3 (W12, two trivial tasks): 69 L3/L4 BLOCKED-no-seeder + waterfall face ANSWERED NEGATIVE (no ask surface under the wrapper; unanswered ask wedges the turn); 30 NOT-OBSERVABLE — needs access-ask prompts (B-4 after FINDING-1)

Evidence root: `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-20\session-B3\` (README maps every
artifact to the claim it proves; `recon-w12.txt` = the pre-boot offline recon; per-command
`.json` → `.out.json` pairs in `session-B3/driver/`; screenshots in `session-B3/shots/`). Boot per
the W9 recipe on the throwaway `multitask` profile, port 8877, WMI-detached, HEAD `39a0dca`;
profile copy md5-verified pre-boot and CONFIRMED to carry W7's seam wiring
(`dispatchApprovalSeamFor(ctx, host, sessionId)` at profile `lib/plugin.js:427`); kill timers
armed at launch (30-min internal + 45-min WMI backstop + 20-min driver wrapper + 18-min
self-exit), all cleared at teardown. `server.log` zero error lines; page error log has ONE entry —
a 401 from the executor's own mis-navigated first goto, not a product pageerror; zero
pageerror/React errors. Teardown: all six lane pids verified gone, port 8877 no LISTENING line,
zero playwright browsers, profile document left clean (roster keys nulled, revision 4), stock
`web` profile byte-identical (md5 AND mtimes).

**Task budget: 2 tasks** (1 authorized + 1 amendment recorded BEFORE the second send in
`session-B3/task-budget-w12.txt`). Each = one composer send → one dispatcher turn, ZERO worker
turns, tiny prompts/outputs.

- **FINDING 0 (why L3's round-trip was unreachable by construction): no live path can insert a
  review-posture row.** Pre-boot recon at HEAD `39a0dca`: the spawn gate (`src/core/tools.ts:297`)
  fires only on a `worker-dispatch` posture hit; `reviewPosture.set` has ZERO callers in `src/`
  (tests only); the live-reachable surfaces — the 9 host commands (`w12-12-cmdlist`), the settings
  document (`w12-10-describe2`: Config + roster-mirror keys only), and the adapter — carry zero
  posture exposure (`grep posture src/adapter/` = 0 hits; `dispatcher-resolve`'s alwaysAllow
  writes the CONSENT table, not posture). The PLAN's "in-session Multitask API insert in the test
  harness only" exists only in the offline harness (FakeDshHost). No seeder was shipped (Q1/U-D;
  W12 brief). ⇒ **69 L3 (gated round-trip) and L4 (posture auto-answer) both recorded
  BLOCKED-no-seeder** — L4 was the PLAN's expected outcome; a gated dispatch stays unreachable
  until a human-decided posture act exists (Q1's recorded reversal path).
- **L3's waterfall face answered instead (W7's recorded live-only question: "whether the shipped
  client approval composer still answers under the wrapper's root frame") — ANSWERED NEGATIVE.**
  Code level: the composer ships in the served 11.2 MB combo bundle (`dsh-client-ui-approval` ×4,
  `approval/request` ×2, `allowed-once` ×1 — `w12-15-combo`). Live level (task 2,
  escalation-shaped): preset verified `workspace-write` via `/permission` (`w12-24`, approval
  component = `ask`); the dispatcher was asked to write one file OUTSIDE the workspace — an action
  that cannot be sandbox-allowed and must raise a host approval ask. Result over a ~3-minute
  window: NO ask surface of any kind — zero approval/dialog/modal/toast elements including hidden
  DOM (`w12-33-deep`), zero fixed/sticky overlays, sidebar chips unchanged (the `3 个需要你` chips
  are the pass-5 landed-undelivered markers, per the standing B1/B2 guidance); the turn stayed
  `进行中` (`w12-31`/`w12-34`), the file was never created, no refusal copy appeared.
  Screenshots: `shots/w12-shot-during-turn.png`, `shots/w12-shot-final-state.png`. Verdict: the
  approval waterfall SHIPS but does not ANSWER under the wrapper root frame.
- **FINDING 3 (for the sweep; sharpens 69 Q2 without re-opening it): an unanswered host approval
  ask WEDGES the dispatcher turn.** The offline Q2 pins prove a seam refusal (a RETURNED outcome)
  never wedges a turn; live, the answerer can be absent-and-silent, and dispatch approvals ride
  the seam's own cancellation with no core timer. Mechanism not distinguishable post-hoc — either
  `ctx.approval.request()` hangs with no answerer UI, or pwsh hung/retried for other reasons —
  but no file, no refusal, and no surface either way. A gated dispatch whose ask reaches this same
  waterfall would wedge identically: a host-ask timeout/timeout-deny (or a proven answerer) is a
  precondition for L3 ever passing live.
- **30 → NOT-OBSERVABLE live (observation-only; NOTHING ticked).** No approval prompt ever
  rendered, so no 30 AC was observable: the clamp bait was never consumed, no option set /
  location line / expired copy ever appeared. Structural answer for the sweep: 30's re-hosted ACs
  (option set, session always-allow, clamped detail, expired copy, secret-stored copy) require
  ACCESS-REQUEST prompts — relay asks raised by `request_access` and rendered as 81's cards (or
  the shipped `ctx.userQuestions.ask` pathway). A dispatch-approval ask is a different surface
  (host approval waterfall, `toolName: spawn_worker`); a host tool-permission ask is a third
  surface (host composer). **30 therefore cannot be live-verified by dispatch-approval or
  host-permission prompts: it needs session B-4 after FINDING-1's fix** (or a worker-toolset
  diagnostic), which also unblocks 69 L1/L2.
- Also live-reproduced en route: composer send transport green again (input 112 → 0, message
  landed — `w12-21`/`w12-22`); activation flip `data-dispatcher` false→true (`w12-17`); final
  describe shows the schemaVersion-4 roster snapshot with `pendingAsks: []` throughout and
  `blocked: null` on every row (`w12-36-describe-final`) — nothing parked; FINDING 1 is untouched
  by this lane (the dispatch seam rides `spawn_worker`, not `request_access`). Driver quirks for
  W13 recorded in `handover-W12.md`: navigate only via the driver's `goto` handler with the fresh
  `?token=` URL (a `location.href` assignment lands on the 401 page — tonight's one console
  error); JSON typing eats backslashes (type Windows paths with forward slashes); inherited
  not-re-entrancy-guarded poll loop / fresh-filenames rule unchanged.

No AC box on 33, 69, 81, or 30 is ticked by this session; no ticket file moves. Dispositions
belong to the W14 sweep with the evidence review. Lane torn down; handover at
`.scratch/_overnight-2026-09-20/handover-W12.md`.

### 2026-09-20 — AC3 / Gate 2 executed in the worktree (overnight run, W16): typecheck clean both configs, `npm test` 1118 pass / 0 fail / 271 suites — Gate-2 box left UNTICKED for the closure sweep

**Worktree state found:** `C:\Users\TZhen\Desktop\dsh-bot-always-on` was ABSENT — directory gone,
no `clone/always-on-dispatcher` branch, `git worktree list` showed only main. This matches the
launcher's recorded decommission (`dsh-bot.ps1` header note, 2026-09-19: the checkout "whose whole
17.27-17.33 batch merged" was dropped from the launcher targets). Nothing was force-reset; the
worktree was recreated additively, per the workflow doc's own recorded setup
(`.scratch/clone-always-on/worktree-workflow.md` §1): `git worktree add
C:/Users/TZhen/Desktop/dsh-bot-always-on -b clone/always-on-dispatcher main`. The branch is fresh
at main HEAD **`3826525`**, i.e. exactly the launcher `-Sync` end-state (its sync convention is
`git merge --ff-only main`, a no-op here); tree clean, `= main`.

**Dependencies:** `node_modules` is junction-shared with the main checkout (`mklink /J`) — `npm ci`
was NOT run (junction-shared rule; the 2026-09-18 clean-install record stands as the deps
evidence, same citation as AC6's note below).

**Gate 2 run, in `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`,
HEAD `3826525`:**
- `npm run typecheck` — clean (both `tsconfig.json` and `tsconfig.client.json`), exit 0.
- `npm test` — **1118 pass / 0 fail / 271 suites** (0 cancelled / 0 skipped / 0 todo), offline
  node:test run, ~123 s. Matches main's current counts exactly (worktree content = main HEAD).
- No network, no LLM, no dsh-host contact from the run itself (a parallel live session B-4 runs in
  the MAIN checkout only; the worktree run shares no state with it — the junction is
  node_modules consumption, read-only).

Gate 2's checkbox above is deliberately left UNTICKED — box-ticking belongs to the closure sweep
(W17); this comment is the evidence record it can tick from.

### 2026-09-20 — live pass 5, Session B-4 (W21, two composer sends = the cap, one task): 81 dispatch card LIVE-VERIFIED (FINDING 2 fix confirmed); W19 FINDING 1 fix confirmed at the model level (first live worker to call request_access); NEW FINDING 4: the parked ask is lost to worker settlement (69 L1/L2 + 30 stay blocked, now at the core); NEW FINDING 5: B-3's wedged turn PERSISTS across restart and eats sends

Evidence root: `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-20\session-B4\` (README maps every
artifact to the claim; per-command `.json` → `.out.json` pairs in `session-B4/driver/`; offline
host-state reads in `session-B4/probes/`; screenshots in `session-B4/shots/`). Boot per the W9
recipe on the throwaway `multitask` profile, port 8877, WMI-detached, HEAD `3826525`; gates
before anything: typecheck clean, **1118/271/0**; rebuild + profile remove→re-add, and the W19
markers confirmed in the SERVED copy pre-boot ("Asking for access" ×2 + `request_access` ×2 in
`lib/worker/prompt.js`, `structuredPresentationMeta` in `lib/adapter/dispatcher-tools.js`,
`dispatchApprovalSeamFor` ×3 in `lib/plugin.js`; `LIB_DIFF_EMPTY`). Kill timers armed at launch
(30-min internal + 45-min WMI backstop + 20-min driver wrapper + 18-min self-exit); after
driver-1's window closed the backstop was killed and re-armed fresh (net never absent). All
cleared at teardown: all five lane pids gone, port 8877 no LISTENING line, zero chrome, profile
document left clean (all three roster keys nulled — TWO sessions were activated in-memory —
revision 9), stock `web` profile byte-identical (md5 AND mtimes).

**Task budget: 2 sends (the cap)** — both recorded BEFORE sending in
`session-B4/task-budget-w21.txt` (1 authorized + 1 retry under the pre-recorded
transport-failure rule; the retry went to a DIFFERENT clean session). Driver-1 artifacts were
wiped by driver-2's boot (driver `rmSync` at start) — re-emitted as `*.reconstructed.json` with
verbatim payloads and honesty notes; the load-bearing wedge evidence was never at risk (offline
reads).

- **81 → LIVE-VERIFIED (the worker-dispatch card; W19 FINDING 2 fix works live).** After the
  spawn settled, the dispatcher conversation rendered `[data-card-kind="worker-dispatch"]` with
  `data-gating="ungated"` and `data-tool-call-id`, text "Live-lane probe B4 / 流
  live-lane-b4-probe / 结果 2dbc148e-… / 审批门 ungated" (`w21-42-pollA`, `w21-44-final`,
  `shots/w21-shot-final-dispatch-card.png`). B-2 saw zero cards from two settled spawns; tonight
  the FIRST settled spawn produced the frozen card. `gated: true`/`approval-allowed` remains
  NOT observable (needs the L3 posture lane; posture EMPTY per Q1) — unchanged.
- **W19 FINDING 1 fix → MODEL HALF LIVE-VERIFIED.** Worker `2dbc148e` ("Live-lane probe B4") is
  the FIRST live worker ever to call `request_access` (4 predecessors skipped it): one turn,
  response "Access request sent: class `credential`, target `dsh-live-b4-probe-cred` (name only,
  no value). Tool returned confirmat…" — call made exactly once, credential NAME only per the
  contract, then the worker ended its turn (stop-and-wait; `openTurnStartSeq: null`,
  `pendingCalls: {}`). Evidence: offline read of the host session projcache
  (`session-B4/probes/w21-worker-2dbc148e-turnoutline.json`; the live page never shows worker
  internals).
- **FINDING 4 (new; blocks 69 L1/L2 + 30 at the core): the parked ask does not survive worker
  settlement.** The tool returned success in 46 ms (park ack), the worker ended its turn per the
  W19 contract, host settlement fired, and the core marked the worker `completed`+`delivered:true`
  6 s after spawn (`multitask_dispatcher.json` marker `updatedAtMs` 1789849870070);
  `pendingAsks: []` at every observable moment (revision 8); no card; no blocked marker; and
  `/dispatcher-resolve 2dbc148e allow` → honest error "No pending access ask for 2dbc148e in this
  chat." (`w21-43`). The offline composition pin parks a real ask and it stays pending — the
  harness never fires the settlement notice the real host fires when the child's turn ends. The
  W19 stop-and-wait contract and dsh settlement semantics conflict: **the relay's park never gets
  a window.** Also recorded: the dispatcher's delivered narration says "B4 remains parked pending
  your grant/deny" while core truth has no ask (`w21-44-final` convTail) — the user channel was
  told an ask is pending when none is. Sharpens FINDING 3/Q2.
- **69 L1 → NOT-TRIGGERED (transport halves split):** the resolve COMMAND half is live
  (registered pre-input per the token guard; routes and refuses honestly on a stale worker —
  `w21-43`), but the pending-card half never had an ask to render. **69 L2 → NOT-TRIGGERED**
  (nothing ever waited: `blocked: null`, straight to completed). **30 → NOT-OBSERVABLE** (no ask
  card ever rendered; the 340-char clamp bait was consumed by the park but no card ever showed
  it; nothing on 30 contradicted). Both need FINDING 4 fixed first.
- **FINDING 5 (new; B-3 inheritance; for W13): the wedged dispatcher turn PERSISTS across host
  restart and silently eats sends.** First send went to session-cf5249cf ("Diagnostic probe",
  the B-2/B-3 session): transport green (draft 835 → 0, outcome "sent", session file written),
  but no turn ever ran — revision frozen at 1, transcript never rendered the message (even after
  a seat re-open), network verified alive. Offline host-state read
  (`session-B4/probes/w21-wedge-cf5249cf-turnboundary.json`): the session carries a persisted
  OPEN TURN (`openTurnStartSeq: 415`, `lastTurn: 18`, `lastStepBoundary {kind:start, seq:427}` —
  B-3's wedged pwsh call) and the message sits in the session inbox `next-turn` behind it.
  Tonight's boot REBUILT that state from disk — W12's "the wedge died with the teardown"
  assumption is FALSE. cf5249cf is the only session with an open turn (projcache sweep). No
  wrapper interrupt surface, no host command settles it. **Session C must NOT activate
  session-cf5249cf**; B-4 completed the whole flow on "Dispatcher start command"
  (session-cd03250b-…, `openTurn: None`) after a fresh `/dispatcher-start` there.

No AC box on 33, 69, 81, or 30 is ticked by this session; no ticket file moves. Dispositions
belong to the W14 sweep with the evidence review.

### 2026-09-20 — live pass 5, Session C (W13, one composer send = 1 of 3 budget): 27/28 presence+sections LIVE (Needs-you/Finished + landed markers, real rebuild population), 29 firehose LIVE-VERIFIED with provenance, 31 restart honesty LIVE-VERIFIED across a real host kill+reboot; FINDING 5 re-confirmed read-only across two boots; three agent rulings recorded (27 ×2, 28 stand-in)

Evidence root: `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-20\session-C\`
(README maps every artifact to every claim). Boot per the W9 recipe, port
8877, WMI-detached, main HEAD `7ac8edc` content = code-identical to `3826525`
(tracker-only commits between); gates before anything: typecheck clean,
**1118/271/0**. Profile refresh SKIPPED per the cheap-check rule: served copy
verified md5-identical to the repo `lib`/`client` build AND carrying the W19 +
presence markers (`structuredPresentationMeta` ×2, `dispatchApprovalSeamFor`
×3, `request_access` ×2; client `applySessionMirror` ×3, `data-card-kind` ×2,
`needs-you` ×14, `roster.section` ×10). Kill timers armed at launch (30-min
internal ×2 boots, 45-min WMI backstop, 20-min driver wrappers, 18-min driver
self-exits); driver-1's window closed mid-run → cmd/ archived BEFORE driver-2
(whence zero artifacts lost, unlike B-4). Teardown clean: driver closed first
("driver-closed"), all lane pids gone, port 8877 NO LISTENING line, zero
chrome, profile document left clean (revision 3, all roster keys null), stock
`web` profile byte-identical (md5 AND mtimes).

Per-ticket one-line verdicts (details + artifacts in each ticket's dated
comment; NO AC box ticked anywhere — the sweep owns boxes):
- **27 presence:** snapshot v2 semantics, dots (needs-you/unavailable/idle),
  landed marker, derived activity lines, and fail-closed stale degradation
  LIVE-VERIFIED; running ring NOT-CAPTURED (poll gap — worker ran ~10–15 s
  between polls); blocked marker NOT-TRIGGERED (nothing blocked naturally).
- **28 sections:** Needs-you + Finished LIVE-VERIFIED with real population
  incl. across the restart (needs-you ×2 → ×3, landed rows stay visible,
  delivered row collapses to `已完成 | 1 个已完成`); Active NOT-CAPTURED
  (same poll gap); collision precedence unobserved (offline pins stand).
- **29 streaming:** firehose LIVE-VERIFIED — check_workers row renders
  `request_access: credential`, the resolver's phrase for the one REAL
  `request_access` tool/call (made live in tonight's B-4 lane on this
  session, persisted in the transcript, rendered live now; provenance =
  `session-B4/probes/w21-worker-2dbc148e-turnoutline.json` +
  `session-C/driver/w13-23-cwrows.json.out.json`); the null-omission path
  also live-confirmed on tonight's own fresh check. No polish item open.
- **31 restart honesty:** LIVE-VERIFIED across a real SIGKILL + reboot +
  re-activation — stale mirror degrades honestly pre-activation; first
  post-activation snapshot carries all restored rows (rebuild-before-publish
  live); one-time wake narrates honestly; no invented rows/notice. Nuance
  recorded: markers carry no delivered bit → rebuilt panel says "not
  delivered yet" for a pre-restart-delivered result until the wake
  reconciles (obligation-truth, design-flagged, not fixed).
- **FINDING 5 (read-only):** cf5249cf's persisted open turn
  (`openTurnStartSeq: 415`, `lastStepBoundary {kind:start, seq:427}`,
  `lastTurn: 18`, parked pending call) SURVIVED both of tonight's boots —
  verified offline, session never activated, never sent to. The lane ran on
  session-cd03250b (`openTurn: None`), which worked end-to-end again.
- **Bonus evidence:** 81's worker-dispatch card rendered again from
  tonight's own settled spawn (`gating="ungated"`); 58's durable
  `redriveAttempts: 2` persisted across boots.

**Agent rulings recorded tonight (each a dated comment on its ticket,
explicitly SUBJECT TO HUMAN REVERSAL per the Q1 precedent):**
1. Ticket 27 — delivered/landed semantics under ADR-0018's first-visible-ack:
   keep the shipped `delivered` flag, re-glossed as "result has become
   user-visible at least once"; landed = settled + not yet visible (flag-flip
   and first-visibility coincide on the shipped deliver path; grounded in
   tonight's rebuild/redrive observations).
2. Ticket 27 — presence markers stay pull-only honest state markers; a
   reference-style UNSEEN-attention badge is technically reachable in the
   wrapper but needs new client state (per-session seen watermarks) = new
   scope, own ticket; not decidable as a rationale alone.
3. Ticket 28 — Needs-you STANDS as the attention surface (canonical record of
   ADR-0010 context (a)): no push seam exists so native push-imitation would
   be simulated push (forbidden by shipped honesty pins + U-A); the stand-in
   is now wrapper-native (the shell needs-you counter IS the attention
   marker), not a capsule-era placeholder. Reverses cleanly if the human
   wants the unseen-badge scope.

The ADR-0010 text itself was NOT edited (per brief); its "re-opened, not
re-decided" rationales are now decided at agent level pending human
reversal/review. Task budget: 1/3 sends, recorded pre-send
(`session-C/task-budget-w13.txt`).

### 2026-09-20 — agent (W22: FINDING 4 FIXED offline — merge c8849a7; see ticket 69's W22 comment for the mechanism + the park-vs-settlement agent ruling)

FINDING 4 (this file's Session B-4 record, `7ac8edc`) is fixed offline: `request_access`'s tool
call now stays pending while the ask sits in the relay (park the TOOL, not the turn-end), so dsh
settlement can no longer eat a parked ask or mark a worker completed+delivered while a decision
is owed. Worker prompt unchanged (W19 contract intact; denial final). RED-checked, gates on
merged main 1125/0/272, B3 holds. Full record + SEMANTICS DECISION ruling (subject to human
reversal) + the B-5 live verification list: ticket 69's comment 2026-09-20 (W22).
