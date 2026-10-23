# 143 — Research: can the dsh 0.2.1 UI be extended (patched/overlaid) so spawned dispatchers show the team-leader glyph in the sidebar?

**Status:** open
**Labels:** ready-for-agent
**Origin:** owner instruction 2026-10-23: "scribe a ticket for next team to do online research and investigate how to modify 0.2.1 UI to display our team leader glyph". This ticket owns the RESEARCH + PROBE half; the seat/identity ruling stays with ticket 140.
**Related:** ticket 140 (needs-info — the seat/identity ruling; this research feeds it), ticket 123 + resolved 118 (the `◆` glyph machinery, retained uncomposed), ticket 114 (the 0.2.1 port; `dsh.bundle.patch` + `dev/cordis.web.patch.yml` precedent), ADR-0024 rider + addendum (what the current ruling licenses), ticket 130 (durable `dispatcher_sessions` mark — a fact a UI could read), ticket 122 (provenance), `docs/research/plugin-install-workflow.md` and `dev/cordis.src.patch.yml` / `dev/cordis.web.patch.yml` (how the repo already patches dsh at boot).

## Problem

Stock dsh 0.2.1-rc.2 hides every `origin: 'subagent'` session from the sidebar (`sessionVisible` returns false — verified in `@deepseek-ai/dsh-client-ui-workspace/lib/client.js:965`). So a spawned dispatcher (the owner calls it "our team leader") has no sidebar row, and the licensed `sidebar.session.row.leading` glyph seat never mounts for it (ticket 140). The owner wants the glyph to show anyway and has asked: can we MODIFY the 0.2.1 UI to make it happen — and is there any upstream-sanctioned way to do it that we have not yet found?

Two gaps must both close before a glyph can render: (1) a sidebar ROW for the spawned dispatcher (stock filters it out), and (2) a CLIENT-READABLE identity fact distinguishing a dispatcher child from a worker child (our `dispatcher_sessions` durable mark lives in our storage domain; the client cannot read it today).

## Research questions (answer ALL; cite file+line for every claim)

- [ ] **Upstream extension points, online-first.** Search the dsh docs/changelog/source for any sanctioned way to make an `origin: 'subagent'` session sidebar-visible in 0.2.1: a settings flag, `sessionVisible` filter/override, catalog/visibility API, a client-slot that can inject rows, or anything added in 0.2.1-rc.x. Sources: official dsh docs/CHANGELOG if reachable, the installed profile trees under `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\*` (read `lib/*.js` — our own machine copy), and the local reference tree ONLY per `read-before-reference-tree-work.md` (license-unsafe: behavior only, never copy).
- [ ] **The 0.2.1 patch surfaces we already have.** Determine exactly what `dsh.bundle.patch` (our shipped patch), `dev/cordis.web.patch.yml`, and `dev/cordis.src.patch.yml` can and cannot alter in the CLIENT bundle: do they support replacing/wrapping a client-ui module (e.g. the `sessionVisible` check or the sidebar row renderer), or only our own plugin code? Is a client-module patch profile-wide (affects stock sessions too) and what does that imply for the ADR-0024 "stock dsh is the only UI" ruling? Note: `docs/surfaces.md` records a known failure mode — duplicate insert rows make the settings form disappear; check whether the same hazard applies to bundle patching a client module.
- [ ] **Identity channel for the client.** Our `dispatcher_sessions` mark is in our storage domain. Can the client see ANY of: the sessionKind projection (how does it reach the client in 0.2.1 — what channel does `dsh-session-projection-cache` use, and is it readable for a hidden subagent row?), a preset row visible to the client, the peer roster, or dsh-owned session metadata? Find the smallest client-readable discriminator for "this child is a dispatcher" that adds no new host channel beyond what rulings license — or state plainly that it needs a new channel and what kind.
- [ ] **Precedent check.** Did any earlier dsh version, or any other dsh plugin we can find (online or in installed profiles), render a mark for a non-user session in the sidebar? Anything that made hidden sessions visible? Cite where you found it.
- [ ] **Verdict.** End with one of: IMPLEMENTABLE (a concrete, ruled-compliant path exists — file a follow-up ready-for-agent implementation ticket), NEEDS-RULING (path exists but breaches ADR-0024 as written — say exactly which sentence of the ruling must change), or NOT-POSSIBLE (no path short of forking dsh — say why in three sentences).

## Acceptance

- [ ] Every claim carries a file+line (installed profile tree) or a URL (online docs/changelog); no guesses, no "should work".
- [ ] Findings written to `docs/research/` following the existing research-file format; no source or prompt text copied from the license-unsafe reference tree (paraphrase only).
- [ ] Verdict section present with one of the three outcomes above; if IMPLEMENTABLE or NEEDS-RULING, ticket 140 gets a cross-reference comment pointing at the research (do not edit the ADR).
- [ ] All work offline or read-only against installed trees; NO browser automation against a live dsh, no dsh key export, no model calls. Online research = docs/changelogs/source reading only.

## Constraints

- Do NOT implement any UI change under this ticket — research and filing only.
- Do NOT edit ADRs or ticket 140's ruling fields; a cross-reference comment is the most.
- The reference tree (`reference material-NOT LICENSE SAFE DONT COPY-grok bot/`) stays read-only, behavior-level, per `read-before-reference-tree-work.md`.
- If the upstream search needs credentials or a page is unreachable, record that as a research gap instead of working around it.

## Comments

### 2026-10-23 — filing
Filed on the owner's instruction. Ticket 140 keeps the decision authority (which seat, which channel); this ticket answers "is modifying the 0.2.1 UI technically possible, by what mechanism, and at what cost" so the owner can rule with facts. Labels `ready-for-agent` because the research itself needs no ruling — only its outcome does.
