# RACOONS fan-out research: prior art, wheels, seams (7-agent sweep)

- Date: 2026-10-19
- Status: **evidence, not rulings.** Consolidated by the PM from seven parallel background researchers (4 web, 2 local-repo, 1 academic). Feeds `PRD-racoons.md`.
- Product under design: **RACOONS** — Remove Agent Context Overhead — Offload, Not Summarize. 记忆焚化工. A harness-agnostic open-source library that keeps a coding agent's context healthy by removing provably useless content while fresh, instead of letting a bloated agent summarize lossily at a threshold.

---

## 1. Did anybody already do this? (web sweep)

**The full combination is unclaimed.** Three of the four mechanisms already ship somewhere; the pieces:

| Piece | Already shipped by | Their gap |
|---|---|---|
| Entry-time capping of oversized results | context-diet (Claude Code plugin), dsh-sol (ObservationPack, sha256 spill + recall id) | lossy digest or spill-only; single harness |
| Whole-episode verbatim eviction into append-only log + recall ids | dsh-argp, context-fold, maskpoint, context-gc, context-surgeon | pressure-triggered (not while-fresh), LLM in loop, or no library API |
| Task/episode-close folding | pi-cwl (typed episodes, deterministic eviction), taskfold | retained artifact is an LLM-written summary (taskfold) or unarchived (pi-cwl) |

**Genuinely unclaimed:**

1. **The negative fact** — no harness or repo replaces a failed search with a written "not found in these files, do not re-read" record. Existing placeholders do the opposite: they invite re-running the tool.
2. **The posture** — nobody makes "native compaction never fires" the success criterion; context-gc explicitly disclaims it; others fall back to LLM summarization.
3. **Line-range retention** ("Showing lines 40–60 of 900…") as a first-class primitive.

Closest single project: **dsh-argp** (append-only log as sole truth, deterministic graph pruning, closure lifecycle, seq recall — but pressure-triggered, dsh-only, LLM-proposed stage 1, no negative facts). Conceptual ancestor: **pi-cwl**. Two of the closest projects are already dsh plugins — the target ecosystem has partial implementations, so RACOONS wins on the package (portable library + while-fresh trigger + negative facts + healthy-window goal), not on any single mechanism.

For context: Claude Code's microcompact is deterministic but not retrievable (re-run is the remedy); Codex CLI and OpenHands compact by LLM summary; Cline auto-summarizes; Amp hands off to fresh threads; Cursor/Windsurf/Zed/Aider publish nothing comparable.

## 2. Memory products (web sweep)

Nobody solves the problem. The field splits into cross-session memory (Letta, Zep/Graphiti, Mem0, Cognee, LangMem — all LLM-written facts, wrong axis) and in-session compression (lossy or irrecoverable). Single closest shape: **Context Surgeon** (MIT, owned history, append-only JSONL, evict/restore by stable id) — but a 45-star CLI proxy with no library API: prior art, not a base.

- **Worth evaluating as dependencies:** `sqz`'s engine (deterministic, byte-exact dedup refs `§ref:HASH:L40-80§`) and `tare` (rule-based re-encoding + expand) — narrow tool-output compressors callable inside RACOONS' cap rule.
- **Vocabulary to copy (idea, not code):** LlamaIndex's chat-store `archive_oldest_messages` + priority truncation interface.
- **Main alternative to watch:** Headroom (Apache-2.0, large adoption, library API) — lossy incremental compression, not provable removal.
- **License trap:** context-mode is Elastic-2.0 in-repo despite MIT on npm — excluded.
- **Naming:** Cognee already ships a `forget` API; the RACOONS name sidesteps the collision.
- Anthropic ships provider-side deterministic context editing (`clear_tool_uses_20250919`, thresholds + keep rules) — validates the mechanism at API level; a provider seam worth listing per-adapter.

## 3. Academic check — including citation corrections

**Corrections to the dsh-forget proposal's citations (the proposal is non-binding; the PRD must not repeat these errors):**

- **2609.20804** ("retrieval rarely used"): a 176-setting study, not 35,000 runs; it actually endorses rule-based elision *before* LLM summarization, not summarization-free context; and the retrieval-neglect claim is contested by 2608.16370 (retrieval calls surge 21→64 when state is dropped) and 2609.26121 (reversibility is critical; disable-only variants degraded performance).
- **2608.23651** ("description beats replay"): the benefit is the *absence of the failed string*, not the wording — a bare `[attempt 1 failed]` marker recovered about the same. Small models (135M–1.7B). Defensible claim: "remove the failed call's surface form, leave a terse marker" — not "clever written negative facts work because of their content."
- **2609.32961** is the "35,000-run study," but its abstract reports "fewer tokens need not mean faster or cheaper" (one-third-token policies 20–80% slower) — it does **not** say "fewer, larger compactions win." Do not cite it for that.

**Crowded adjacent architecture art:** 2602.22402 (lossless trimming of raw tool outputs, verbatim turns, cache-aware), 2608.21690 Scroll (append-only event log + eviction index bound to exact addresses — near-identical architecture), 2607.23809 ACM (agent-triggered lossless editing, offload + query). The **untested delta** is the *trigger* (episode close, not token threshold) and stable-id whole-episode eviction. Cache-position-aware editing is partially preempted (CADOC 2609.37012, EOQ-scheduled edits).

**Supporting:** 2609.26121 DTOC (placeholders + reversible restore — reversibility mandatory), 2607.15257 SearchOS-V1 (explicit Failure Memory stops repeated failed searches), 2608.24188 Paritok-4B (extractive span selection, 96% verbatim identifiers), 2608.11248 EvoGraph-Mem (per-insight negative evidence tracking), 2607.12161 (38.4% tool-token cut *raised* billed cost 6.8% — cache reads dominate), 2610.15093 TurnCost (98.6% of input tokens prefix-cached; observation size explains ~4% of cost variance — token-cost savings is the wrong primary goal; healthy-window framing is right), 2610.21893 GACC-Bench (all ten studied compressors leave substantial gaps to full-context — the failure mode RACOONS avoids by not compressing).

## 4. Harness seams (rescoped per owner: + OpenCode, ZCode, Trae, CodeBuddy, Qoder, CherryStudio, Orca; − OpenHands, Goose, Crush)

Five seams as **capability flags**: (1) mutate tool result before context, (2) rewrite history mid-session, (3) at-rest hook, (4) live token counts, (5) durable log.

| Harness | 1 result | 2 history | 3 at-rest | 4 tokens | 5 log | License |
|---|---|---|---|---|---|---|
| dsh (reference) | Y | Y | Y | Y | Y | — |
| Gemini CLI | Y (`AfterTool`/tail-call swap) | Y (`BeforeModel` request override) | Y | Y (`usageMetadata`) | Y | Apache-2.0 |
| OpenCode | Y (`tool.execute.after`) | Y (`chat.messages.transform`) | Y (`session.idle`) | Y | Y | MIT |
| Cline | Y (`afterTool` replacement) | Y (`beforeModel.messages`) | Y (`afterRun`) | Y (`snapshot.usage`) | Y | Apache-2.0 |
| Claude Code | Y (`PostToolUse.updatedToolOutput`) | N | Y (`Stop`) | P (statusLine JSON) | Y (`transcript_path`) | closed |
| Codex CLI | P (MCP tools only) | N | Y (`stop`) | P (app-server) | Y | Apache-2.0 |
| Cursor | P (MCP only) | N | Y | P | Y | closed |
| CodeBuddy | Y (all tools) | N | Y | P | Y | closed |
| Qoder | Y | N | Y | N (derive from JSONL) | Y | closed |
| Trae | P (append only) | N | Y | N | Y | closed |
| ZCode | P (append only, cannot replace) | N | Y (+ idle tasks) | N | Y | closed |
| CherryStudio | P (MCP only) | N | N | N | N | AGPL-3.0 |
| Orca | P (inherits host hooks) | N | P | P | N | MIT |
| MCP (portable) | P (own results only) | N | N | N | Y (server-side) | spec |

**Verdict:** minimal port = seam 1 + one at-rest hook + own log file. Seam 2 (history rewrite) is the luxury — besides dsh only Gemini CLI, OpenCode, Cline expose it. **Adapter order after dsh: Gemini CLI, then OpenCode, then Cline.** MCP proxy is the universal floor adapter (partial pruning of MCP-routed tools on any harness). Closed append-only hosts (ZCode, Trae) degrade to advisor mode: RACOONS writes a ledger the agent can read but cannot shrink the context.

## 5. Wheels

**Token counting:** exact offline parity is impossible; the pattern used by other harnesses (aider→litellm, Claude Code local estimate + authoritative `usage`) is: local counter for thresholds, reconcile from API `usage` (incl. `cached_tokens`) after each call. TS wheels: `gpt-tokenizer` (MIT, exact OpenAI encodings), `ai-tokenizer` (multi-provider, ~97%+ with outliers — fallback only), Anthropic `count_tokens` as a free network calibration oracle. `@anthropic-ai/tokenizer` is dead (Claude-2 era) — skip.

**Prompt-cache mechanics — verified for OpenAI, Anthropic, Gemini, DeepSeek:** all four are strict prefix caches; an edit at position N invalidates N..end and preserves 0..N−1 (Anthropic/OpenAI add breakpoint lookback — an *earlier* entry survives a changed suffix). No provider offers mid-context KV reuse that survives rewriting earlier bytes. Consequences: prune from the end / near the tail; rewriting is cheap only in the recent window; old material must only be touched at cold-cache boundaries (resume, idle past TTL, model switch). DeepSeek: ~0.02–0.03× read price, TTL hours–days (overnight idle is a free eviction window).

**Storage:** sha256 + one-file-per-digest (zero deps) or cacache (ISC per npm; license field ambiguous in-repo — verify before use) for blobs; `node:sqlite` (Node 22.5+) or better-sqlite3 (MIT) as index; plain JSONL for the append-only event log. No off-the-shelf "session log with content-addressed store" exists — build it, it's small.

**Span extraction:** `vscode-languageserver-textdocument` (MIT, zero deps) is the closest standard for line semantics (CRLF/LF/CR, clamping); hash UTF-8 bytes (`TextEncoder` + node:crypto or @noble/hashes) for platform-stable digests; watch UTF-16 vs byte offsets.

**Testing:** Vercel AI SDK `ai/test` (mock models, Apache-2.0), MSW/nock/Polly.js for record-replay. No fake token-meter library exists — build one (fixed counts + scripted `usage`). We hold ~9,667 real local session transcripts usable as (anonymized) replay fixtures.

**Licenses:** no GPL/AGPL among candidates (CherryStudio AGPL is a harness, never link it).

## 6. Local constraints (repo inventory)

- **Clean-room rules bind the open-source repo** (clean-room-license-audit + ADR-0018 B9): never verbatim-copy reference-tree source, prompts, tool strings, identifiers, or protocol artifacts; adapted copying only (restructured, independently named); no reference codenames even in comments; shipped identifiers trace to the glossary; negative vocabulary tests guard model-facing assets. Reference-tree provenance is "accepted risk," not legal clearance.
- **Seed code exists:** `src/core/microcompact.ts` is pure and host-import-free (deterministic trigger/selection/constants); `src/adapter/microcompact.ts` is the dsh wiring including the shadow-price swap protocol. ADR-0029 rules compaction starts deterministic. The `DshHost` port and `wake-bus` are further examples of the agnostic-core/adapter pattern.
- **House PRD conventions:** 17-section skeleton, S-numbered testable success criteria, non-goals inside Goals, amendment-by-strikethrough-with-date, M-milestones. "Pruning" is on the dsh-bot glossary avoid list — RACOONS defines its own vocabulary (see PRD Appendix A).

## 7. Local evidence (measured, from the owner's own 9,667-session store — a ZCode CLI store; dsh's own compactor has never fired locally, so numbers are directional, not dsh-specific)

- **Composition ceiling:** tool results 38.0%, tool-call args 13.1%, assistant+user text 48.9% of visible bytes — the last term is out of scope by design; RACOONS extends the healthy window within a structural ceiling.
- **Junk targets:** >8 kB results = 49.3% of tool-result bytes (80.1% are file reads); failed/unresolved search episodes carry 58.5% of tool-result bytes (21,494 episodes, median 2 calls, p90 11, max 290); repeat reads 8.1% of visible bytes; 29.4% of dropped read bytes get re-fetched after compaction (the indictment of lossy compaction); false-drop ratio median 0.119, p90 0.855.
- **Quality reality check:** selection-quality q median 0.41 overall (editing sessions 0.398, read-heavy 0.60) vs. the red-team's 0.6 ship gate — gates must be judged per workload; the deterministic floor carries the product.
- **Settled engineering decisions worth keeping on merit:** write-once records; all-or-nothing validation (~30 checks); unmentioned nodes default keep; the model never supplies bytes (hashes/ranges/≤400-char notes only); freshness fence (logRevision CAS); crash table (orphan prune inert on resume; idempotent re-land keyed by (span, sha256)); protected content recomputed live (system prompt, newest tail, in-flight turn, open approvals, quoted-this-turn, janitor's own records); circuit breaker (2 consecutive validation failures → behave as if absent, one log line + one wake line); retrieval by id only, no text-search index, no second database.
- **Kill criteria to adapt:** deterministic floor must capture ≥80% of what an LLM selector would drop, else the LLM layer is dead; re-fetch >10% or any user-visible false-drop error kills that rule (floor stays); if forced loss still fires in most long sessions, RACOONS is a tax, not a fix; bursts (400k-token turns) outrun any cadence — lag guard required.
- **Still-open live questions:** orphan-prune recovery across a hard kill; whether `turn-stopping` fires on aborted/errored turns; peer-roster growth rate per turn.
- **Answered already:** plugin may append `compaction/prune` (runtime accepts, CI gate is lint-only); `measure().totalTokens` is the quantity native compares; `postCompactTokenCount` unreliable (129/1,028) — use `truePostCompactTokenCount`; profile-patch into preset requires `agentPresets.serviceFor`.

## 8. PM synthesis — what this means for the PRD

1. **Lead with the package, not a mechanism:** harness-agnostic core + capability-flag adapters + while-fresh trigger + negative facts + healthy-window posture. Every piece but the package exists somewhere.
2. **Negative facts are the differentiator** — but write them terse and factual: the measured benefit is removing the failed surface form, not prose quality.
3. **Cache policy is verified physics:** tail-window operation, append-mode sealing (new short record, no history rewrite) as the portable default, replace-mode only where seam 2 exists, cold-boundary-only eviction of old material.
4. **Degradation ladder is the portability product:** Tier A (rewrite: dsh, Gemini CLI, OpenCode, Cline) → Tier B (ingest: Claude Code, CodeBuddy, Qoder, Cursor/Codex MCP-only) → advisor mode (ZCode, Trae) → MCP floor.
5. **Success = healthy window + less forced summarization; cost is a constraint** (TurnCost + 2607.12161 show token-cut ≠ savings; owner ruling concurs). Metrics derive from the harness's own transcript + `usage` — no second database.
6. **Reversibility is mandatory** (2609.26121): every removal lands in an append-only, content-addressed ledger with a recall id.
7. **Safety posture survives from the evidence trail on merit:** all-or-nothing guard, protected content, breaker, model-never-supplies-bytes.
