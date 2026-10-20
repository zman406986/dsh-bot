# 126 — Add the RACOONS M1 integration

**Status:** open
**Labels:** ready-for-human
**Related:** RACOONS integration ruling, 2026-10-20; `docs/research/racoons-integration-2026-10-20.md`

## Problem

This worktree has no committed microcompact modules. It needs an additive RACOONS path on the
committed baseline, behind its own flag, that leaves the existing behaviour untouched.

## What to do

- [x] Stage tool results on session/event and process them at agent/pre-step.
- [x] Publish validated entry replacements through session.append surface operations.
- [x] Support entry and append modes. Refuse rewrite and rehydrate.
- [x] Vendor the required M1 core and dsh adapter sources.
- [x] Add an opt-in config field and offline tests.
- [x] Document transient storage and checks that could not be run.
- [x] Register the config field in the settings card and both locale faces.
- [ ] Live boot pass on a mock-LLM run (needs a kill timer and a human at the keyboard).

## Constraints

- Work only in the integration worktree.
- Do not access the owner's dirty tree or require its untracked modules.
- No API keys, no live LLM calls, no storage domain version bump.

## Verification (2026-10-20)

Everything below was executed on the worktree, against fakes and the real engine. No live dsh boot,
no browser, no API key.

| Gate | Command | Result |
| --- | --- | --- |
| Worktree typecheck | `npm run typecheck` | exit 0 — vendor build + host + client |
| RACOONS adapter | `npx tsx --tsconfig tsconfig.client.json --test test/adapter-racoons.test.ts` | 9/9 pass |
| Port + real engine | `... --test test/adapter-racoons-port.test.ts test/adapter-racoons-engine.test.ts` | 7/7 pass |
| Settings card pairing | inside the full suite | pass — field registered in schema order, both locales |

The real engine caps a staged result and archives the original byte-for-byte, and performs a real
append-mode seal from explicit miss evidence.

## Comments

2026-10-20: Renumbered from ticket 114 at the racoons-integration lane merge — the main lane had already claimed tickets 114-125. Same ticket, new number.
2026-10-20: Ticket filed before implementation.

2026-10-20: **Build blocker fixed.** The vendored `guard/bytes.ts` imported `complementByteRanges`
from `util/bytes.ts`; it is exported by `util/lines.ts`. Fixed in source and in the vendor copy, then
the whole vendor tree was re-synced from source (`scripts/resync-vendor.mjs` in the RACOONS repo).

2026-10-20: **`.volatile()` removed** from the config field. That modifier does not exist on this
schemastery version; the field is now `z.boolean().default(false)`, matching `enabled` and
`inboxEnabled`.

2026-10-20: **Settings card wired.** Adding a config field without a card control fails ticket 47's
pairing test by design. Added `racoonsEnabled` to `SETTINGS_CARD_FIELDS` in schema order plus
`settings.card.field.racoonsEnabled.{label,hint}` in both the English and Chinese faces.

## Pre-existing failures, not caused by this branch

`test/inbox-watcher.test.ts` fails 4 of its 15 cases with `assert.ok(report)` falsy. Proven
pre-existing: the same 4 cases fail identically in a scratch worktree at the base commit `1f5ae26`,
with no RACOONS code present (11 pass, 4 fail, same four names). Those tests also hang the process at
teardown, which is why a full-suite run does not print a summary.

This branch changes no inbox file. `git diff --name-only 1f5ae26..b687bb8` lists only the RACOONS
adapter, the vendor tree, `plugin.ts` (additive config field and a guarded registration block), the
settings card, both locale faces, the three new test files, and docs. The inbox code is untouched.
Worth its own ticket in dsh-bot.

## Remaining gaps

- **Durable ledger.** Blobs and ledger rows are in memory. Recall dies with the process. A follow-up
  ticket is filed in the RACOONS repo.
- **No recall tool.** Recall is API-only here. The model cannot ask for an archived record.
- **Plugin passes library defaults.** `capHeadBytes` is `null`, so the cap rule skips with a
  `configuration-required` record. Enabling the flag alone does not cap anything until a head size is
  configured. Seal needs structured miss evidence, which the adapter can inject but `plugin.ts` does
  not yet supply from tool output.
- **No live verification.** Host payload shapes, append return values, and replace bounds were
  exercised only against fakes built from the structural contracts.
