# A `dsh.client.inject` declaration obligates consumer-driven materialization: smallest boot-time set, never `immediately` for ordinary plugin packages

**Status:** draft

**Approval:** non-human — agent-drafted, pending human sign-off

**Numbering:** 0014, continuing the capsule epic's block started at 0013. 0010–0012 are reserved to design-17 §9's ADR plan (ADR-0010 presence-as-projection → tickets 27/28; ADR-0011 session-scope always-allow → ticket 30; ADR-0012 activation-replays-durability → ticket 31), which supersedes design-16 §9's older conditional ADR-0010 sketch; the capsule ADRs start at 0013 (slot choice), 0014 (this file), 0015 (browser-test infra).

A plugin's client module materializes in the browser **only if the boot graph points at it**. Every plugin package must therefore declare `dsh.client.inject` naming **exactly the packages whose services it binds at boot** (the smallest set that materializes), and must **not** declare `dsh.client.immediately: true` — that flag belongs to the shipped bootstrap tier. A package nobody points at and that is not `immediately` is registered-but-dormant forever: its host half loads, its browser half never runs.

## Context

- Ticket 34's diagnosis, read from `@deepseek-ai/dsh-client-modules` 0.1.5-rc.1: materialization is **consumer-driven** — `arriveGraphRow` walks each boot-graph row's `inject` package list and arrives those rows first; bootstrap rows are those with `dsh.client.immediately: true` (`lib/client.js:253–269`). The dispatcher's original record was `{ platform: "web", external: [...] }` with no `inject` — so the module factory registered and nothing ever arrived it. That was the shipped bug: host face fine, browser half never ran.
- `dsh.client.inject` is "informational package-name dependencies, not Cordis service injection" — it orders graph arrival (`DshClientManifest`, `dsh-package-manifest/lib/types/types.d.ts:38–52`). Every shipped `dsh-client-ui-*` package declares one.
- **Worked case — ticket 34's landed fix (commit 80c2932)**, now in `package.json`:

  ```json
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-locale"],
    "external": ["react", "react/jsx-runtime"]
  }
  ```

  Each entry justified (ticket 34 comment): the renderer provides the `slots` service the module binds at boot (`shell.overlay` capsule entry + five `tool.call.toolview` entries); the locale provides the `locale` service (the `multitask-dispatcher` en/zh namespace). The record is pinned by a regression assertion, `test/client-face-scaffold.test.ts:132–148` ("declares dsh.client.inject after the shipped idiom; no immediately flag").
- **Why the smallest set holds here:** `@deepseek-ai/dsh-client-ui-settings` is deliberately *not* declared. The roster's settings watch is a runtime-dynamic `ctx.inject(["settings"], …)`, not a boot-time bind, and the `settings` service materializes with the shipped composition regardless — bootstrap-tier `dsh-client-locale` already lists `dsh-client-ui-settings` in its own `dsh.client.inject`. Declaring it would add arrival-order coupling for a service we never bind at boot.
- **Why never `immediately`:** in shipped 0.1.5-rc.1 only the bootstrap tier declares it (`dsh-client-ui-renderer`, `dsh-client-locale` package records). The web boot creates a plugin for every boot-graph row and `assertEntriesActive` fails loud on any non-activated entry — an ordinary package forcing itself into the bootstrap tier is off-idiom and unnecessary, since inject-walking already arrives every declared dependency before its consumer.

## Considered options

| Option | Rejected/kept because |
|---|---|
| **A. Declare the smallest boot-time `inject` set; no `immediately` (ticket 34's landed fix)** | **Chosen.** Matches the shipped idiom exactly; every entry justified against a boot-time bind; offline-verifiable (record parses under the host-half parser's rules; regression-pinned in the scaffold suite). |
| B. Over-declare (renderer + settings + everything conceivably used) | Rejected: couples our arrival to services bound dynamically, drags extra rows into our boot prefix, and rots as the client face evolves. Smallest set is the auditable rule. |
| C. Declare `immediately: true` on our package | Rejected: reserved for the shipped bootstrap tier in 0.1.5-rc.1; a plugin package self-promoting to bootstrap is unnecessary (inject-walking covers arrival) and untested against future host versions. |
| D. Declare nothing; rely on runtime-dynamic `ctx.inject` | Rejected — the shipped bug class: dynamic injection executes *inside the module*, so a module that never materializes never injects. Offline suites stayed 515-green while the browser half was dead; only the boot graph tells the truth. |

## Consequences

- **Every new boot-time-bound service requires adding its package to `dsh.client.inject`**; omission fails silent offline (the module is dormant, not crashing) and only a real launcher boot exposes it — hence the served-page/boot-graph check stays a standing browser-pass step (ticket 33; ADR-0015) and the scaffold suite keeps pinning the record.
- Runtime-dynamic `ctx.inject` remains the channel for services not bound at boot; it needs no declaration when the service ships in the default composition anyway (worked case: `settings` via locale's own inject row).
- `external` stays `["react", "react/jsx-runtime"]`: the bundle shares the host's React, per the esbuild contract test.
- The contract is version-pinned to 0.1.5-rc.1 behavior (`arriveGraphRow`, `assertEntriesActive`, `DshClientManifest` rules); re-verify on dsh upgrades per the standing drift rule.
- Honest scope: this ADR records what ticket 34 landed and ratified, as a draft; the launcher-boot ACs of ticket 34 (served page, dormant composition, activation flip) discharge in ticket 33's browser pass.
- Sources: ticket 34 (diagnosis, landed fix, per-entry justification); `docs/research/dsh-capsule-seams.md` (bundle/boot facts re-verified 2026-09-18); epic 35 process req 2.
