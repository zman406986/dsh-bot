# PRD — RACOONS: Remove Agent Context Overhead — Offload, Not Summarize

| | |
|---|---|
| Document | PRD-racoons.md |
| Status | **Draft — awaiting human acceptance** |
| Names | EN: **RACOONS** · CN: **记忆焚化工** |
| Tagline EN | "Remove Agent Context Overhead — Offload, Not Summarize." |
| Tagline CN | "及时做减法，不要等AI脑子撑爆了再逼它总结" |
| Host product | Any agent harness the user can modify (adapter model); reference adapter: dsh |
| Shape | Separate open-source repo; dsh-bot becomes the reference implementation example |
| Language | TypeScript (Node ≥ 22) |
| Legal posture | Clean-room (Appendix B); all dependencies MIT/Apache-2.0/ISC-compatible |

Research basis: `docs/research/racoons-prior-art-wheels-seams-2026-10-19.md` (7-agent sweep), `docs/research/dsh-forget-proposal-2026-10-19.md` (non-binding input), `.scratch/repo-analysis/2026-10-19-*.md` (measured evidence).

---

## 1. Problem

A coding agent's context fills with content whose uselessness is knowable the moment it appears — oversized file dumps, failed searches, superseded reads — yet every mainstream harness leaves it in place until the context is bloated, then asks the bloated agent to summarize itself down to size. That summarization is lossy, unauditable, and fires at the exact moment the agent is least able to judge what mattered. Measured on the owner's own 9,667-session store: median 296k → 25k tokens per compaction (90.7% thrown away), and 29.4% of dropped read bytes are re-fetched afterward — the agent destroyed information it still needed.

The industry answer so far is either lossy compression or bigger windows. Neither keeps a long session healthy: compression degrades quality (every studied compressor leaves substantial gaps to full-context performance), and bigger windows just move the cliff.

**RACOONS' claim:** most context overhead is trash whose uselessness is provable at creation time or at the close of the episode that produced it. Remove it then — verbatim survivors, terse negative facts for the rest, everything offloaded to an append-only ledger with recall ids — and the agent never reaches the cliff. Compaction stops being a mechanism and becomes a failure indicator.

## 2. Goals

1. **Extend the healthy context window**: long sessions run further before any forced lossy summarization, targeting no forced loss at all in most long sessions.
2. **Reduce the frequency of lossy summarization**: the harness's native compaction should fire rarely, ideally never, in RACOONS-managed sessions.
3. **Remove only provable trash**: every removal is either provably useless (with a terse written negative fact so the agent does not redo the work) or retrievable verbatim by recall id. Nothing retained is ever rewritten.
4. **Run on any harness the user can modify**: a harness-agnostic core plus thin adapters, with a documented degradation ladder so partial harnesses get partial value.
5. **Preserve prompt-cache hit rate**: all operations respect verified prefix-cache physics (§6.7); cost is a constraint, not the goal.
6. **Be safe by construction**: all-or-nothing validation, protected content, circuit breaker; the worst failure is "RACOONS stops working," never "RACOONS corrupted the session."

**Non-goals**

- Token-cost optimization as a primary goal (evidence: cache reads dominate; token cuts can raise cost — 2607.12161; TurnCost 2610.15093).
- Replacing the harness's native compaction — it stays mounted as a backstop and failure indicator.
- Cross-session memory, vector/graph recall, or any LLM-written memory (that is a different product axis; see Letta/Zep/Mem0).
- Touching assistant or user text (48.9% of visible bytes — the structural ceiling, accepted).
- Mid-context KV-cache tricks (no provider offers them; verified for OpenAI/Anthropic/Gemini/DeepSeek).
- Building a second transcript database — RACOONS derives metrics from the harness's own transcript and API `usage`.
- Any LLM in the default path (an optional, deferred, ranges-only selector is gated behind kill criteria, §13 M5).

## 3. Hard constraints

1. **Clean-room** (Appendix B): no material copied from the dsh reference tree — no source, prompts, tool strings, identifiers, protocol artifacts, or codenames; adapted copying only; glossary-traced identifiers; negative-vocabulary tests on model-facing assets.
2. **Cache physics** (verified, all four providers): caches are strict prefix caches; an edit at position N invalidates N..end. Therefore: operate near the tail; seal by append when the history-rewrite seam is absent; evict old material only at cold-cache boundaries.
3. **Determinism by default**: shipped rules are code, not model calls.
4. **Reversibility**: every removal lands in an append-only, content-addressed ledger; recall restores exact bytes (2609.26121: disable-only variants degrade performance — restore paths are mandatory).
5. **No second source of truth**: the harness transcript remains authoritative; RACOONS' ledger stores only what it removed plus pointers.
6. **License hygiene**: core and adapters MIT/Apache-2.0/ISC-compatible dependencies only; AGPL harnesses (e.g. CherryStudio) are never linked, only adapted to where their license permits.

## 4. Success criteria

| ID | Criterion (testable) | Baseline (owner's store) | Target |
|---|---|---|---|
| S1 | Long sessions (≥20 turns) completing with **zero** forced-loss events | 35% of deep sessions never compact | ≥ 80% |
| S2 | Median tokens at first forced loss ("healthy depth") | ~296k | > 1M |
| S3 | Forced-loss events per long session | ~3.0 (2,080 events / 695 compacting sessions) | ≤ 0.3 (stretch 0) |
| S4 | Dropped bytes re-fetched later | 29.4% | < 10% |
| S5 | User-visible errors attributable to false drops | unmeasured | 0 per 100 sessions |
| S6 | Cache hit rate (cached-token share from `usage`) vs. control | — | no sustained regression > 5% relative |
| S7 | Core purity: `@racoons/core` has zero harness imports (lint-enforced) and ships ≥ 2 adapters (dsh + Gemini CLI) unchanged | — | gate for M2 exit |
| S8 | Every removal restorable byte-exact via recall id (property test over the ledger) | — | 100% |

S1–S3 measure the goal (healthy window, less forced summarization). S4–S5 measure safety. S6 is the cost constraint. S7–S8 are structural gates.

## 5. Actors & roles

- **Owner/user**: installs RACOONS on a harness they can modify; configures caps and thresholds.
- **Host harness**: owns the session, transcript, and model calls; exposes seams (capability flags, §7).
- **RACOONS core** (`@racoons/core`): meter, episode tracker, rules, guard, engine, ledger. Pure TypeScript, no harness imports.
- **Adapter** (`racoons-<harness>`): maps core to one harness's seams; declares capability flags; contains no policy.
- **The agent itself**: never sees RACOONS machinery beyond terse markers, negative facts, and (Tier A/B) a recall tool. The agent is not asked to manage memory.

## 6. Product behavior

### 6.1 Posture

RACOONS is a cleanup layer, not a compaction replacement. Native compaction stays mounted as backstop; every tie goes to the harness. The headline telemetry is "did native compaction fire?" — if it fires often, RACOONS is failing (S1–S3), regardless of how much it removed.

### 6.2 Rule: Cap (entry-time, highest measured yield)

Tool results above the size threshold (default 8 kB — >8 kB results carry ~49% of tool-result bytes, 80% of them file reads) are capped **as they enter**: head + exact omitted counts + a line-range marker + a content-addressed spill in the ledger + recall id. Works on every seam tier ≥ B without touching history (cache-free by construction). Selector wheels (sqz-style byte-exact dedup refs) may be plugged into this rule later.

### 6.3 Rule: Seal (failed-search episodes — the flagship)

An **episode** is a burst of tool calls pursuing one target (reads/greps/globs of paths). It closes when no new path is read for N steps or the turn ends. On close:

- The **hit** (if any) is kept — whole, or as line ranges once §6.6 ships.
- The **misses** become one terse **negative fact**:

```
[search: <target>] not found in: <path> · <title or first heading> · <lines> · <size>, …
No match in these files for this target. Do not re-read them.
```

Evidence shape: 21,494 episodes, median 2 calls, p90 11, max 290; unresolved episodes alone carry 58.5% of tool-result bytes. Writing style is deliberately terse and factual — the measured benefit is removing the failed surface form, not prose quality (2608.23651 mechanism finding); SearchOS-V1's Failure Memory corroborates the anti-re-read effect.

**Two sealing modes** (cache-driven, §6.7):
- **Append mode (portable default)**: misses stay as capped stubs; the negative fact is appended as a new record. No history rewrite → zero cache invalidation. Works on Tier B and the MCP floor.
- **Replace mode (Tier A only)**: the miss span is atomically replaced by the negative fact. Bigger savings; invalidation bounded by seal latency (seal within one turn of episode close — a latency SLO, not a token cadence).

### 6.4 Rule: Evict + Recall (closed episodes, by pointer)

Old sealed material leaves the window **whole**, into the ledger, under a stable id with a short title; the in-context stub names the id. Never re-summarized, never folded into other records. Recall restores exact bytes (hash-verified). Eviction of material already deep in the prefix happens **only at cold-cache boundaries** (session resume, idle past provider TTL, model switch) — verified physics: a head eviction invalidates the whole suffix and never pays back; overnight idle is a genuinely free window on DeepSeek-class caches.

### 6.5 Rule: Spans (line-range retention — deferred, most correctness risk)

When a large result was used only in part, keep the used lines verbatim and drop the rest with `[Showing lines X–Y of N in <path>. Full content restorable via recall id.]`. Selection order: cross-reference (lines the agent later quoted/derived from — deterministic matching), then access tracking (followed by edit/re-read/citation), then optional LLM range selection (M5, gated). Prior art: nobody ships line-range retention as a first-class primitive; extractive selection preserves 96% of verbatim identifiers at ~26% size (2608.24188).

### 6.6 Fresh zone and cache policy (verified physics)

All rewrite-mode operations are confined to the **fresh zone** — the recent window between the cache watermark and the tail. Nothing below the watermark is ever rewritten mid-session. Appendix C of the research note holds the per-provider table (OpenAI, Anthropic, Gemini, DeepSeek: prefix-only confirmed; breakpoint lookback nuances; no mid-context reuse anywhere).

### 6.7 Guard (safety posture, kept on merit from the evidence trail)

- **All-or-nothing validation** (~30 structural checks — pairing balance, freshness fence, hash match, adjacency); any failure rejects the whole plan; no partial application, ever.
- **Unmentioned nodes default to keep** — plans are shrink-lists, never allowlists.
- **The model never supplies bytes**: where a model is involved (M5 only), it proposes hashes/ranges/≤400-char notes; the guard copies bytes from the ledger.
- **Protected content**, recomputed live: system prompt, policy sections, newest tail, in-flight turn, open approvals, content quoted this turn, RACOONS' own records (anti-recursive-eviction).
- **Circuit breaker**: 2 consecutive validation failures → RACOONS disables itself for the session; one ledger line + one line in the next turn. Failure posture is always "forget nothing," never "degrade silently."
- **Crash rules**: orphan prune records are inert on resume; re-lands are idempotent keyed by (span, sha256).

### 6.8 Degradation ladder (the portability product)

| Tier | Seams | Harnesses (surveyed) | What works |
|---|---|---|---|
| A — rewrite | result + history + at-rest | dsh, Gemini CLI, OpenCode, Cline | everything: Cap, Seal (replace), Evict, Spans |
| B — ingest | result + at-rest | Claude Code, CodeBuddy, Qoder; Cursor/Codex (MCP tools only) | Cap, Seal (append), Evict-at-cold-boundary via rehydrate-on-resume, Spans at entry |
| C — advise | append-only context + at-rest | ZCode, Trae | ledger + negative facts written to a file the agent can read; no context reduction (documented honestly as advisor mode) |
| Floor — MCP proxy | shapes MCP-routed results | any harness with MCP | partial Cap/Seal for MCP tools, no fork |

Recommended adapter order after dsh: **Gemini CLI → OpenCode → Cline** (all open-source, all five seams, documented APIs). dsh-bot is the reference adapter and first production user.

### 6.9 Meter and telemetry

Local tokenizer estimate (gpt-tokenizer / provider packs) drives thresholds; authoritative counts reconcile from API `usage` (incl. cached tokens) after each call — the pattern every surveyed harness converges on. Telemetry (forced-loss events, re-fetch rate, cache share, bytes sealed) derives from the harness transcript + ledger; no second database. `postCompactTokenCount`-style derived fields are never trusted where a true count exists.

### 6.10 What RACOONS never does

No summarization of any content, ever. No rewriting of retained content. No model-written memory. No fixed-interval maintenance — operations fire at entry and at-rest only. No local text-search index. No announcement of eviction in agent-facing policy beyond terse markers (behavioral-distortion risk: watch note-hoarding and re-read rate in dogfood).

## 7. Architecture

```
@racoons/core            (pure TS, zero harness imports — S7, lint-enforced)
  meter        estimate + usage reconciliation
  episodes     episode open/close detection (path-burst heuristic)
  rules        Cap · Seal · Evict · Spans   (pluggable Rule interface)
  guard        all-or-nothing validator, protected set, breaker, crash rules
  ledger       append-only event log + content-addressed blob store (sha256) + sqlite index
  engine       orchestrates at entry-events and at-rest hooks; capability-aware
racoons-<harness>         (thin adapters; declare capability flags; no policy)
  racoons-dsh             reference adapter (generalizes src/adapter/microcompact.ts)
  racoons-gemini-cli      portability proof (M2)
  racoons-opencode / racoons-cline   (M5+)
  racoons-mcp             proxy floor adapter
```

The core is seeded by lifting `src/core/microcompact.ts` (already pure, ADR-0029-aligned: deterministic first) and the existing swap-protocol adapter knowledge into `racoons-dsh`; dsh-bot then consumes the packages. Data flow: entry-event → Cap decision → (at-rest) episode close → Seal plan → guard → apply (append or atomic replace per tier) → ledger write → telemetry.

## 8. Implementation language strategy

TypeScript on Node ≥ 22 (`node:sqlite`), matching the reference implementation and the TS-first adapter ecosystem (OpenCode, Cline SDKs are TS). The core avoids Node-only APIs where a browser/worker target is plausible (adapter side may use them). Package manager npm, matching dsh-bot.

## 9. API sketch (clean-room, illustrative)

```ts
interface HarnessAdapter {
  capabilities: CapabilityFlags            // mutateResult | rewriteHistory | atRest | liveTokens | log
  onResult?(cb: (r: ToolResult) => Promise<ToolResult | void>): Disposable
  rewriteHistory?(plan: ReplacePlan): Promise<ApplyResult>   // Tier A only; atomic per §6.7
  onAtRest(cb: (s: SessionSnapshot) => Promise<void>): Disposable
  appendRecord(rec: LedgerRecord): Promise<RecallId>
  estimateTokens(text: string): number      // local; reconciled from usage where available
}

interface Rule { id: string; plan(ctx: RuleContext): SealPlan | CapPlan | EvictPlan | null }

engine = new RacoonsEngine({ adapter, rules: [new CapRule({ limit: 8192 }), new SealRule(), new EvictRule()] })
// recall surface (Tier A/B): tool exposing recall(id) -> exact bytes, hash-verified
```

## 10. Model-facing assets and README copy (all new copy)

- Cap marker: `[Capped: showing <a>–<b> of <N> lines · <M> kB omitted · recall <id>]`
- Negative-fact template: §6.3 (terse, factual; no prose flourish).
- Recall tool description: "restores the exact original bytes of a sealed record by id."
- README opener (owner-supplied, verbatim):
  - EN: "Compaction is stupid, forcing a memory-bloated agent to produce summary is always lossy. Let RACOONS eat your memory trash instead."
  - CN: "记忆焚化工 — 及时做减法，不要等AI脑子撑爆了再逼它总结"
- All model-facing strings ship under `assertNewCopy`-style negative-vocabulary tests (Appendix B).

## 11. Integration checklist (reference adapter: dsh)

1. Generalize `src/adapter/microcompact.ts` into `racoons-dsh` (pre-step listener = at-rest; `surfaceOp replace` + shadow-price swap protocol = rewriteHistory; `storageDomain` = ledger sink).
2. Keep ADR-0029 behavior: deterministic pass first; boundary marker remains the resume success marker.
3. Resolve pre-M3 live checks (from the evidence trail): plugin-appended `compaction/prune` pricing; orphan-prune recovery across hard kill; `turn-stopping` on aborted/errored turns.
4. dsh-bot's own dispatching/worker behavior is untouched — RACOONS is orthogonal to the multitask dispatcher.

## 12. Testing plan

- **Offline unit**: rule correctness (episode close detection, cap thresholds, span math with CRLF/BOM fixtures), guard checks incl. the crash table, ledger CAS/idempotency — grouped in one run per session (house rule: smallest set that can fail).
- **Fake token meter** (build; none exists): fixed counts + scripted `usage` for reconcile paths.
- **Replay fixtures**: anonymized samples from the local 9,667-session store; property test: every sealed record recalls byte-exact (S8).
- **Cache regression harness**: recorded request sequences asserting prefix stability (no rewrites below watermark except at cold boundaries).
- **Live-boot checks** (dsh, gated by the standing live-test rules incl. kill timers): the three §11 items, plus S1–S6 telemetry collection in dogfood.

## 13. Milestones

| M | Scope | Exit criteria |
|---|---|---|
| M1 | Repo skeleton (name, license, CI); core: meter, ledger, Cap, Seal (append mode), guard, engine; `racoons-dsh` at parity with current microcompact | offline suites green; dogfood: S4 re-fetch < 10% on sealed lanes; forced-loss rate ≤ baseline |
| M2 | `racoons-gemini-cli`; usage reconciliation + telemetry dashboard (transcript-derived) | S7 (core purity, 2 adapters); S6 no cache regression |
| M3 | Evict + Recall (replace mode, Tier A); cold-boundary scheduling; breaker live checks | S1 ≥ 50% interim; S8 property test green; orphan-prune live check passed |
| M4 | Spans (deterministic selectors: cross-reference, access tracking) | S1 ≥ 80%, S2 > 1M, S3 ≤ 0.3 |
| M5 | Optional LLM range selector (gated); `racoons-opencode`, `racoons-cline`, `racoons-mcp` floor; advisor mode (Tier C) | kill gates enforced: LLM layer ships only if the deterministic floor captures < 80% of its bytes (else the LLM layer is dead weight); adapter matrix updated |

**Kill criteria (any triggers a design review, not silent tuning):** re-fetch > 10% after sealing; any user-visible false-drop error; forced loss still firing in most long sessions after M3; sustained cache regression; deterministic floor under 80% of LLM-selector bytes makes M5's LLM layer mandatory (contradicting the no-LLM default) — then descope M5.

## 14. Risks & mitigations

- **Evidence transferability**: all measurements come from the owner's ZCode CLI store; dsh's own compactor never fired locally. Mitigation: M1 dogfood re-measures on dsh before M3 commits.
- **Selection quality**: q median 0.41 vs. the old 0.6 gate — gates judged per workload; the deterministic floor (Cap + Seal-append) carries most measured bytes regardless of q.
- **Bursts** (400k-token turns) outrun sealing: lag guard — skip and count the skip as a telemetry failure, never batch-storm the fresh zone.
- **Behavioral distortion**: terse markers only; watch note-hoarding, re-read rate, tool calls per task in dogfood.
- **Token-estimate drift**: thresholds from local estimates, reconciled from `usage`; cap threshold hysteresis to avoid flapping.
- **Provider cache changes**: the cache table is dated evidence; re-verify quarterly (cheap: docs check).
- **License**: clean-room discipline + dependency audit gate in CI; cacache's ambiguous in-repo license field must be resolved before adoption (fallback: plain sha256+files).
- **Competitive**: Headroom (lossy, big), context-gc (library shape, disclaims our goal), dsh-argp (dsh-only). Differentiators: negative facts, no-LLM default, portability ladder, healthy-window posture. Re-check the landscape at M2.
- **Adapter churn** (closed harnesses changing hooks): capability flags + thin adapters + canary CI jobs per adapter.

## 15. Open decisions (resolve before M1)

1. License: **recommend MIT** (widest adapter compatibility); Apache-2.0 if patent grant matters to the owner.
2. npm scope: `@racoons/core` + `racoons-<harness>` vs. flat `racoons-*` — recommend scoped for core, flat for adapters.
3. Default cap threshold (8 kB proposed) and seal-latency SLO (one turn) — confirm in M1 dogfood.
4. Whether Tier C advisor mode ships at all or stays documented-but-unbuilt (recommend: document only until a user asks).
5. Core extraction timing: lift `src/core/microcompact.ts` in M1 (recommend) vs. fresh-write the core and deprecate dsh-bot's copy at M2.
6. Whether RACOONS telemetry opts into anonymous aggregate reporting (recommend: opt-in, off by default — this is an open-source trust decision).

## 16. Appendix A — Concept glossary

| Term | Meaning | Avoid |
|---|---|---|
| cap / capping | entry-time size limit on a tool result; spill + marker + recall id | truncate, prune, compress |
| episode | burst of tool calls pursuing one target; closes on no-new-path-for-N-steps or turn end | session, task |
| seal | close an episode: keep hits, write one negative fact for misses | summarize, compact |
| negative fact | terse written record that a target was not found in listed files | memory, summary |
| recall id | stable id restoring exact sealed bytes from the ledger | pointer (alone), link |
| fresh zone | recent window between cache watermark and tail; only zone ever rewritten | working set |
| cold boundary | resume / idle-past-TTL / model switch — where eviction is cache-free | checkpoint |
| forced loss | the harness's own lossy summarization event; RACOONS' failure indicator | compaction (as a mechanism RACOONS performs) |
| trash ledger | append-only log + content-addressed blobs of everything removed | database, index |
| capability flag | per-adapter seam declaration driving the degradation ladder | feature flag |
| advisor mode | Tier C: ledger + facts written, context not reduced | — |

## 17. Appendix B — Copy policy (clean-room)

Binding on the RACOONS repo: no verbatim copying from the dsh reference tree — source, prompts, tool strings, identifiers, protocol artifacts, or codenames (even in comments); adapted copying only (restructured, independently named); shipped identifiers trace to Appendix A; model-facing assets are new copy guarded by negative-vocabulary tests; dated audit notes record each review. First-party host API names (hooks, events) are used as-is where the adapter calls them — that is interoperation, not copying. The reference tree never enters the repo, CI, or build.

## 18. Evidence index

- `docs/research/racoons-prior-art-wheels-seams-2026-10-19.md` — this PRD's research basis (prior art, seams, wheels, citation corrections).
- `docs/research/dsh-forget-proposal-2026-10-19.md` — non-binding input; §1's "35,000-run" citation is corrected in the research note §3 and not relied upon here.
- `.scratch/repo-analysis/2026-10-19-*.md` — measured basis (junk census, pruning surface, cache mechanics, transferability).
- Tracked design trail: `janitor-swap-protocol-2026-10-19.md`, `janitor-redteam-2026-10-19.md`, `segmented-compaction-design-2026-10-19.md`, `shadow-janitor-design-2026-10-19.md`.
- External: arXiv 2607.00692, 2602.22402, 2608.21690, 2607.23809, 2609.26121, 2607.15257, 2608.24188, 2607.12161, 2610.15093, 2610.21893 (see research note §3 for the corrected reading of 2609.20804 / 2608.23651 / 2609.32961).
