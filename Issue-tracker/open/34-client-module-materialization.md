# 34 — Client module never materializes in the browser (dsh.client record needs inject/immediately)

**Status:** open
**Labels:** ready-for-agent
**Blocking:** everything client-side (35 and its descendants). Fix this first.

## Problem

The dispatcher's host face loads (boot succeeds, no plugin-load error), but the browser half
never runs: the web UI shows pure vanilla dsh. The client-module system registers our factory
and never materializes it.

Root cause, read from `@deepseek-ai/dsh-client-modules` (0.1.5-rc.1):

- Materialization is consumer-driven. `lib/client.js` `arriveGraphRow` walks each row's
  `inject` package list and arrives those rows first; bootstrap = rows with
  `dsh.client.immediately: true`. A package no one points at and that is not `immediately`
  is registered-but-dormant forever.
- Every shipped `dsh-client-ui-*` package declares `dsh.client.inject: [...]`; our record in
  `package.json` is only `{ platform: "web", external: ["react", "react/jsx-runtime"] }`.

## Acceptance criteria

- [ ] `package.json` `dsh.client` record declares `inject` naming the client packages whose
      services the module binds at boot — at minimum `@deepseek-ai/dsh-client-ui-renderer`
      (slots) and `@deepseek-ai/dsh-client-locale` (locale, itself `immediately: true`), plus
      `@deepseek-ai/dsh-client-ui-settings` if the roster settings watch needs it materialized.
      Prefer the smallest set that materializes; justify each entry in the ticket comment.
- [ ] After a launcher boot (`dsh --profile web --patch <overlay>` from the desktop
      `dsh-bot.ps1`), the served page's outer HTML / boot graph contains the
      `dsh-multitask-dispatcher` row and the combo bundle route serves our `client/index.js`
      (the served-page check from `docs/research/dsh-plugin-ui-examples.md` Finding 3).
- [ ] With the module materialized, the roster panel's **dormant composition** (ticket 32)
      is visible in a fresh, non-activated chat — screenshot or Playwright assertion recorded
      in a comment.
- [ ] `/dispatcher-start` activates a chat and the panel switches to the activated
      composition; the five dispatcher tool views render when those tools are called.
- [ ] No change to the host half's behavior; offline suite stays green (S8); no new deps.

## Notes

- Keep the path-insert launcher route working; if materialization proves impossible without
  profile-tree installation, document exactly why in this ticket and propose the persistent
  install in a follow-up comment before doing it.
- Follow-on UI work is ticket 35; do not grow scope here.
