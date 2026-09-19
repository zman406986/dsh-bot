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
- [x] **Gate 3 — full-diff provenance review:** a human-free review of the complete branch diff for structural/phrasing/protocol borrow from the reference tree (per workflow §3), findings appended as a dated comment on `Issue-tracker/open/17-behavior-clone-reference-always-on-dispatcher.md` on MAIN. **(Done 2026-09-19 in its re-scoped form — no-verbatim-copy review; `docs/research/no-verbatim-copy-review-2026-09-19.md`, pointer on ticket 17.)**
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
