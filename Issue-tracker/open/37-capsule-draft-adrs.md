# 37 — Draft ADRs for the capsule epic: slot choice, materialization contract, browser-test infra (epic 35, process req 2)

**Status:** open
**Labels:** ready-for-agent
**Epic:** 35
**Blocked by:** 36 (ADR-0013's evidence is the re-verified seam findings).

## Context

Epic 35 process requirement 2: the decisions this epic makes are filed as
**draft, non-human-approved** ADRs under `docs/adr/`, with the suffix
`-draft-nonhuman-approved` in the file name and the header line
`**Approval:** non-human — agent-drafted, pending human sign-off`.

**Numbering must be resolved explicitly (ticket 33's open conflict).** The
sequence currently ends at `0009`. Design-17 §9 reserves:
`0010` presence-as-projection (tickets 27/28), `0011` session-scope
always-allow (ticket 30), `0012` activation replays durability (ticket 31).
Those are reserved to their design-17 tickets even though not yet filed; the
capsule ADRs therefore take **0013–0015** and say so in their headers.

## Requirements

File three ADRs in `docs/adr/`:

1. `0013-capsule-shell-overlay-slot-choice-draft-nonhuman-approved.md` — the
   capsule-vs-alternatives decision: additive `shell.overlay` chip+panel (epic
   design direction) vs right-sidebar takeover vs `sidebar.right.pane.tab`
   keyed claim. Cite ticket 36's re-verified findings and the shipped
   `registry.d.ts` DO-NOT-REGISTER-`root` convention as evidence.
2. `0014-client-bundle-materialization-contract-draft-nonhuman-approved.md` —
   what a `dsh.client.inject` declaration obligates (consumer-driven
   materialization; smallest-set rule; no `immediately` for ordinary plugin
   packages), grounded in ticket 34's landed fix (`package.json`, commit
   80c2932) as the worked case.
3. `0015-browser-test-infrastructure-playwright-draft-nonhuman-approved.md` —
   Playwright as the real-browser mount-test choice, run against a
   `dsh --profile web --patch` launcher boot; execution lives in ticket 33's
   browser pass (this epic's sub-tickets verify offline).

Each ADR: Context / Decision / Consequences, cites its sources (no reference
plugin code), and carries the required suffix + approval header.

## Acceptance criteria

- [ ] Three files exist under `docs/adr/` with the exact suffix in each file
      name and the `**Approval:** non-human — agent-drafted, pending human
      sign-off` header line.
- [ ] Each ADR's header explicitly resolves numbering: states 0010–0012 are
      reserved to design-17 §9's tickets, capsule ADRs start at 0013.
- [ ] `docs/adr/README.md` index lists all three as draft status.
- [ ] No product-code changes; `npm test` still green.

## Verification

File-name grep shows the suffix on all three; the README index includes them;
a reviewer pass confirms each ADR's decision matches epic 35's fixed design
direction (capsule in `shell.overlay`; inject-declared materialization;
Playwright infra) without reopening decided questions.
