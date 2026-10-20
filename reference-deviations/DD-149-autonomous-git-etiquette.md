# DD-149 — Autonomous git/PR duty prompt family vs none
- **Area:** prompt sections (A18)
- **Type:** missing-feature (worker prompt content)
- **Date:** 2026-09-23

## What the reference does
The reference ships a set of composable git/PR instruction blocks in its shared prompt kit. A single component renders a bullet list that assumes the agent owns the repository lifecycle end to end. The themes, in order:

- **Own the lifecycle:** when work on the codebase is done, the agent must stage, commit with a descriptive message, and push to the remote — autonomously, without being asked each time.
- **Identity hygiene:** the repo's git client already has `user.name`/`user.email` configured; reuse that identity and never override it unless the user explicitly asks.
- **Commit granularity:** one commit per logical change; do not batch commits unless told.
- **History safety:** never force-push or amend commits unless explicitly instructed (this rule is a named constant in the source, i.e. treated as core etiquette).
- **Branch containment:** do not leave the current branch unless the user asks.
- **Merge-state containment:** never merge PRs, never enable auto-merge, and (switched by a flag) never flip a PR from draft to ready or otherwise change its merge state — only on explicit instruction.
- **End-of-turn PR cadence:** at the end of every turn, before summarizing, create or update a PR if the branch changed; PRs are draft by default; check for a PR template (several conventional paths) and use it; embed captured artifacts (images/videos) in the PR body via HTML tags with absolute paths; and stay quiet to the user about having opened the PR unless asked.
- **Composition/variants:** the family sits behind a wrapper that swaps in a pair of "no repository access" bullets when the workspace has no repository, and the PR bullet itself has variants for "a managed PR tool exists" versus "the environment handles PRs — do not touch PRs yourself". Artifact-embedding sub-text is switched on by a testing-instructions flag; the merge-state and mark-ready clauses are switched by a capability flag. Tool names are injected rather than hard-coded.

The net effect: any session that touches code — not a special "git mode" — gets a baseline set of git rules for free.

## What the current build does
`src/core/policy/prompts.ts` and `src/worker/prompt.ts` contain no commit, push, branch, or PR guidance of any kind. A case-insensitive grep across all of `src/` for git-workflow phrasing (stage/commit/push, force-push, pull request, draft PR) returns one false positive (an unrelated `setDraft` UI-caret comment in `src/client/context.ts`). The build's workers do receive shell and file tools and operate inside the user's repository, but their prompt gives them no git rules at all: nothing says when (or whether) to commit, nothing forbids force-pushes or history rewrites, nothing constrains branch switching or merge operations.

## The deviation
The reference treats autonomous git etiquette as a core, always-on prompt section for every repo-touching session, with a safety core (history protection, identity reuse, branch/merge containment) plus a product layer (end-of-turn draft-PR cadence, template handling, artifact embedding, silence about the PR). The build has the same exposure — workers running shell/file tools inside real repositories — but none of the rules. The gap is not a mis-transcription; it is an entire set of duties the build never derived. The two layers deserve different treatment: the safety core is etiquette any agent with write access to a user's repo should have, while the always-open-a-PR cadence is a product-policy choice about the harness's deliverable model, not a safety rule.

## Verdict: ASK-HUMAN
Incorporate the safety core as an original, independently derived set of git rules: workers that run shell/file tools in the user's repo should get never-force-push/never-amend, commit-only-when-the-task-implies-it (or when asked), reuse the existing git identity, stay on the current branch, and never merge or flip PR state without explicit instruction — this is cheap, high-value protection consistent with ADR-0018's rule to re-derive rather than copy and the PRD's worker-autonomy framing. The reference's end-of-turn always-open-a-draft-PR cadence, PR-template handling, and stay-quiet-about-it behavior are product policy, not safety: do not absorb them silently; if the dispatcher should produce PRs as its deliverable, that is a PRD amendment / ADR question for the human. Repoless and no-PR-tool variants from the reference map to real build states and should inform how the section is composed, but the text must be written fresh.

## Incorporation notes
- **Where it would live:** a small set of git rules in `src/worker/prompt.ts` (worker system prompt), possibly composed from `src/core/policy/prompts.ts` if the rules differ per worker kind; keep it a self-contained bullet group so it can be included or excluded by workspace type (repo vs no repo).
- **Constraints:** original wording only (ADR-0018 B9); scope it to workers that actually get shell/file tools; "commit when asked / when the task clearly implies it" semantics rather than the reference's always-commit-at-end duty, since the build's dispatcher model does not define end-of-turn PR delivery; never force-push/amend and never merge/flip PR state belong in the unconditional core; identity-reuse and stay-on-branch clauses depend on how the build provisions worktrees (verify before writing the rule).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying of reference prompt text under any circumstances.
- **Effort/risk:** S — one prompt section plus a flag controlling composition; risk is low for the safety core, medium only if the human opts into the PR-cadence product layer (that drags in PR tooling the build may not have).
- **Key reference anchors:**
  - the reference tree's `source/packages/agent/prompts/shared.ts` — the never-force-push-or-amend note constant (line 47); the git-instructions component (lines 67–79) with the lifecycle/granularity/identity/branch/merge/PR bullets; a git-or-no-repository wrapper (lines 81–83) with the no-repo variant; the git-instructions props — flags for suppressing the created-PR mention and for whether a PR can be marked ready (lines 52–57) — showing how it is parameterized.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/agent/prompts/shared.ts` (lines 47–83)
- Build: `src/core/policy/prompts.ts`, `src/worker/prompt.ts` (no git content); `src/client/context.ts` line 312 (only repo-wide match, unrelated `setDraft` UI comment)
