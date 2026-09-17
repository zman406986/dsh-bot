# 36 — Capsule seam verification: re-verify host-tree claims + study the three reference plugins (epic 35, process req 0)

**Status:** open
**Labels:** ready-for-agent
**Epic:** 35
**Blocked by:** none (ticket 34 landed at 80c2932 — the client module materializes).

## Context

Epic 35's process requirement 0 is binding: the scribe's notes
(`docs/research/dsh-plugin-ui-examples.md` — marketing-page summaries only — and
`docs/research/dsh-plugin-ui-patterns.md` — host-tree findings pinned to
0.1.5-rc.1) are a starting map, not an authority. Before any capsule code, the
implementing team must verify with its own eyes the facts the capsule design
rests on, and study real plugin sources for mount/interaction patterns.

**Clean-room is hard:** the three GitHub plugin repos are pattern references
only (mixed licenses; one page flagged "No license") — never vendor,
transliterate, or name-match their code/assets (AGENTS.md; the research-note
header). The `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree is
forbidden outright.

## Requirements

Verify, against the installed dsh 0.1.5-rc.1 tree (paths in
`dsh-plugin-ui-patterns.md` Finding 0) and — where useful — the reference
plugins' public repos, and record a verdict for each:

1. **`shell.overlay` entry anatomy** — what one list entry can actually do:
   click-through default, how an entry opts into pointer events, whether an
   entry can size/anchor an expanded card, error-boundary/abdication behavior.
   This bounds what the collapsed chip + expanded panel can be (ticket 38).
2. **Client→host activation path** — can a client surface cause
   `/dispatcher-start` to execute exactly as when the user types it (session
   send/composer path, `ctx.commandUi`, or other)? If no path is verifiable,
   the verdict is "degrade": the capsule's start affordance becomes copy +
   command hint (ADR-0009: no second activation channel may be invented).
3. **Steer-input affordance** — can the client focus/prefill the host composer
   (for the per-row steer affordance and the conversational stop phrasing)?
   Verify or degrade to a copy-into-composer hint.
4. **Settings deep-link** — can a client surface open the Settings page on our
   `multitask-dispatcher` section (footer link, epic §5)? Verify or degrade.
5. **Profile identity** — is any honest client-visible source for the footer's
   "which profile" provenance line (epic §5)? Flag state already comes from the
   watched settings namespace; profile identity may not exist client-side.

Method: clone/read the three repos (`omdsh-dev/DSH-better-sidebar`,
`Nagi-ovo/dsh-visualize`, `Small-tailqwq/dsh-deep-whale`) for pattern-level
answers (how they mount-test, how they interact with the host), re-read the
shipped `@deepseek-ai/*` packages for ground truth. If GitHub connections fail,
retry through the local proxy (`http://127.0.0.1:7897`).

## Acceptance criteria

- [ ] New note `docs/research/dsh-capsule-seams.md` answers all five seams,
      each verdict backed by `file:line` citations (installed dsh tree and/or
      the plugin repos), with an explicit **verified / degraded** call per
      capsule action (start, steer, settings link, profile line).
- [ ] Where a scribe note is wrong or stale, it is corrected in place with a
      dated correction line; where confirmed, a one-line confirmation is added.
- [ ] Mount-test pattern from the reference plugins recorded as an abstract
      pattern (no code, names, or assets copied); clean-room statement included.
- [ ] Zero product-code changes: `git diff` touches only `docs/research/*`.
- [ ] `npm test` still 515-pass green (untouched).

## Verification

Reviewer (a different agent than the researcher) spot-checks two citations
against the installed dsh tree, greps the new note for any verbatim plugin-repo
code, and confirms the diff scope above.
