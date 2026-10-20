# Dispatcher peer model, chatroom, indicators, and compaction: study findings and owner rulings

- Date: 2026-10-18
- Status: **evidence below is level-8 research (never a ruling); the section "Owner decisions" is a level-1 dated human ruling** and outranks draft ADRs for implementation purposes. Each decision still needs its own ticket, and decisions 1 and 2 change recorded decisions, so their ADRs must be amended or superseded explicitly.
- Sources studied: this repo; the Grok Bot 0.18 reference tree (behavior spec, own nested git); `Fei2411/DeepSeek-Bot` and its fork `QingJ01/DS-Bot-App` (Apache-2.0, untyped JS); `zai-org/ZCode` v3.15.1 (TypeScript monorepo). Read-only; no code copied.
- Per-source detail lives in `.scratch/repo-analysis/` (untracked, disposable): `2026-10-18-agent-awareness-grok.md`, `-awareness-dsbot.md`, `2026-10-18-dispatcher-role-shape.md`, `2026-10-18-memory-compaction.md`, `2026-10-18-zcode-lane-{memory,subagents,plugins,reliability}.md`, `2026-10-18-third-party` (see `third-party-dsh-plugin-comparison-2026-10-18.md` for the earlier no-fork analysis).

## Corrections this study produced

Three things previously believed were wrong, and they change what implementation must build:

1. **Peer messaging already ships.** `send_peer` is registered (`src/core/tools.ts:634-715`), the inbox exists with dedupe and caps (`src/core/peer-inbox.ts`), the envelope is defined (`src/core/peer-types.ts:17-40`), and `peer` is a live wake source (`src/core/wake-bus.ts:14-30`). ADR-0002 already rules peers in scope. What is missing is discovery, status, and prompt mention.
2. **No reference has a verification layer.** Grok Bot's `sand-subagent-auto-review.ts` is a safety approval gate for risky launches, not output QA; its task schema tells the parent "The subagent's outputs should generally be trusted." DeepSeek-Bot has no review step at all. Every tree relies on worker self-checking.
3. **Grok Bot delegates more loosely than we do.** Its coordinator prompt says "Don't root-cause it yourself first" and "Hand off the problem and the outcome, not a prescription"; ours requires goal, constraints, context, success criteria, and report format in every spawn prompt.

## What each source offers

### Awareness and discovery

| | Grok Bot 0.18 | DeepSeek-Bot | us |
|---|---|---|---|
| Discovery | **push** — peer directory rendered into the system prompt every turn, `- Name (id: X) — description`, cap 40 (`system-prompt-assembly.ts:238-247`) | **pull** — nothing in prompt; agent must call `list_bots` (`prompt.js:7`, `tools.js:48-73`) | **none** — no registry, no peer rows in `RosterSnapshot`; `fromName` is the session id |
| Liveness to the model | none; only an error string on send ("That agent no longer exists") | rich on demand: `statusOf` reports working/waiting/approval/idle plus tool and target | none |
| Cache cost | pays prompt instability | keeps a byte-stable prompt | n/a |

The trade is real: push guarantees awareness but breaks the cached prefix; pull preserves caching but an agent that never calls the tool never learns anyone exists. The ruling below resolves it by push-at-the-tail with a stable list body.

### Chatrooms

- **Grok Bot**: max 6 members, created only through the UI; one shared ordered log; responders are @-mentioned members else everyone, round-robin; each member sees only messages since it last spoke (24 cap); a member passes by posting `(pass)`; bounded by 3 rounds, 10 messages total, 2 per member, stop on an empty round, plus epoch cancel on any new message.
- **DeepSeek-Bot**: 2–12 members; creator is admin; one shared log of the latest 60 lines that each member reads through its own hidden session via a per-member `seen` cursor (messages are not forwarded); speaker order from `@Name` else admin-first; round limit `members + 4 (+4 with admin)`, per-member caps, `[PASS]` replies, late-round cap 10; a 15 s grace marks a slot `working` and moves the round on, with the late reply posted afterwards and only the asker notified.

Both handle provenance by marking the message as from an agent, not the user; our `PEER_WAKE_SECTION_HEADINGS` already does the same ("Peer message — not from the user").

### Compaction and memory

- **Grok Bot**: deterministic, provider-reported token counts; summarize in place at ~90%, persist at ~95%; fixed 9-section summary; system prompt and the latest user message stay verbatim; memory in separate files with a synthesis call plus a verification call.
- **DeepSeek-Bot**: deterministic threshold math (`usable = window − reserve`, hard 0.95, check 0.8, regrow check/4) **plus** a cheap steward model call returning `{"action":"switch"|"compact"}`; checkpoint keeps verbatim user and bot messages under 16k; assistant text and tool results dropped but searchable; session parts are separate dsh sessions with an 8-section handoff note.
- **ZCode**: fully deterministic, no model call. `threshold = (contextWindow − min(maxOutput, 21k)) − 13k` (166k on a 200k window), checked before every request. Three layers: **microcompact** clears old tool results at 0.9× threshold keeping the newest 5; **full compact** at threshold summarizes older messages into one synthetic user message; **reactive compact** only after provider overflow. The boundary part carries `lastSummarizedMessageId` + preserved segment head/tail as the **only success marker** — write it as one rollback unit, resume from it.

Ours today: `report-clamp.ts` clamps output size (4000/1200/200/300, 20 roster rows); policy injected once; ledger and standing rules re-injected per turn. No window measurement, no compaction, no parts, no memory, no search, no usage ledger, no LLM seam in `DshHost`.

### Subagent mechanics (ZCode)

- Recursion blocked structurally: the child runtime is built with `subagents: { enabled: false }`, so the subagent port does not exist in the child and both dispatch tools are omitted (`runtime/methods/subagent.ts:305-308`); a second barrier filters dispatch tool names out of inherited allowlists.
- Per-role profiles from Markdown frontmatter: `{tools, disallowedTools, skills, mcpServers, maxTurns, modelSelection, permissionMode}`; spawn tools are filtered out of any inherited allowlist.
- **`RespondToCoordinator`** is a dedicated worker→dispatcher reply channel, distinct from the completion report; parent→child is `SendMessage` (steer/queue/resume); no child↔child.
- Await: `TaskOutput` default 30 s, max 600 s; a 600 s inactivity watchdog aborts a stuck child; the dispatch tool itself has no timeout.

### Extension surface for indicators

**Confirmed in the installed dsh 0.2.1**: `sidebar.session.row.leading` is a real slot, payload `{sessionId}`. The host's own schedule plugin already registers into it (`dsh-client-ui-schedule/lib/client.js:7528`) and the workspace sidebar renders it per row (`dsh-client-ui-workspace/lib/client.js:2306`). Siblings: `sidebar.session.row.hover` (hover-only) and `sidebar.workspaces.session.row.action` (menu item).

## Owner decisions (human ruling, 2026-10-18)

1. **Dispatcher prompt becomes Chief of Staff, with mitosis.**
   Redo the dispatcher prompt to the Chief-of-Staff role: decide whether the work needs a team or a single worker, then hand off the **problem and the outcome** rather than a prescription. It may summon either a leaf worker or **another dispatcher (mitosis)** — a child dispatcher carries the full dispatcher tool surface and its policy, and is a **peer of its creator, not a rank below it**.
   Consequence: ADR-0003 is relaxed for the **dispatcher→dispatcher edge only**; workers remain leaves and may never spawn. This revises our current prompt, which is the stricter one, and needs a dated ADR that supersedes ADR-0003's spawning clause while keeping its worker rule intact.

2. **Optional chatroom broadcasting, 1:1 preserved.**
   Keep the existing 1:1 peer path, and add an optional room as a broadcast channel: a dispatcher can address a named group instead of one agent. Take the best of both references for bounds and speaker order, and note that Grok's turn-based peer roster push is the model for decision 3 with the tail-placement rule.
   Consequence: this is a new product surface with membership, ordering, and termination policy to own. Membership, round bounds, and the slow-member rule must be specified before implementation, not during.

3. **Peer awareness is guaranteed discovery plus status, injected into the prompt.**
   Adopt Grok's push model for discovery — an agent must not need to know a tool exists to learn who exists — **appended at the prompt tail** so the cached prefix survives. Include liveness/status, taking DeepSeek-Bot's `statusOf` shape (working, waiting, approval, idle, plus current tool and target) as the target richness.
   Consequence: the roster must become a stable, testable projection with a defined refresh point; it is injected text, not a tool call.

4. **Adopt ZCode's `RespondToCoordinator`.**
   Add a worker→dispatcher reply channel that is distinct from the completion report, so a worker can report mid-task without ending its turn. Parent→child stays the existing steer path; no child↔child.
   Consequence: ADR-0003 does not block this (it governs spawning and worker↔worker), but the worker contract in `src/worker/prompt.ts` must document the channel, because today it says the only channels back are the final answer and the access ask.

5. **Session-row indicator glyphs.**
   Use `sidebar.session.row.leading` to show a small glyph distinguishing dispatcher sessions, worker sessions, and normal sessions. Nothing else changes in the UI — the native posture stands (ADR-0024).
   Consequence: needs a durable way to identify a session's kind at render time; the slot receives only a session id.

6. **Adopt ZCode's boundary-as-success-marker and microcompact.**
   Compaction must be deterministic. Start with microcompact only — clear old tool results at a ratio of the usable window, keeping the newest few — and record the compaction boundary as the single success marker that resume reads.
   Consequence: needs a host usage/window surface we do not currently consume, and must not become token accounting a local store owns (ADR-0018 U-H). Full compaction and any steward model call are **not** adopted here.

## Constraints that still bind

- **ADR-0006 / ADR-0018 A5**: persistence stays in dsh's session/job store; no second database. Any roster, room log, or compaction marker must live there.
- **ADR-0012** (wording loosened 2026-10-18 to "current shape, revocable"): restart does not re-run work. Boundary markers may be replayed; work may not.
- **ADR-0018 U-H**: no local content-search index.
- **ADR-0018 C13/C14**: no agent-identity roster, no per-agent memory, no group rooms — decision 2 **overrides C14's room exclusion** for this product and must be recorded as such.
- **ADR-0003**: workers are leaves. Decision 1 **relaxes this for the dispatcher→dispatcher edge only** (mitosis); a worker may still never spawn anything. Decision 4 does not disturb it.
- **ADR-0019** (per-dispatcher scoped tools): a child dispatcher gets its own tool surface and its own keyed state, which mitosis must respect rather than share.
- **ADR-0024**: stock dsh is never displaced. Decision 5 uses a host slot and displaces nothing.

## Open questions implementation must not guess

1. **Who does a worker's mid-task reply reach** when the dispatcher is mid-conversation with the user — is it delivered as a turn-opening wake, or folded into the next reconcile? (Decision 4.)
2. **Chatroom membership is by what identity** — session id, dispatcher name, or a user-assigned label? Nothing in our code names agents today. (Decision 2.)
3. **Room termination policy**: adopt Grok's hard caps, DeepSeek-Bot's admin-first ordering plus grace timer, or a simpler fixed round count? (Decision 2.)
4. **What identifies a session's kind** at `sidebar.session.row.leading` render time — origin field, our own marker, or session metadata? (Decision 5.)
5. **Where does the usable-window number come from** on dsh 0.2.1, and is it stable enough to trigger on? (Decision 6.)
6. **What bounds mitosis** — spawn budget, live-dispatcher cap, or no bound? And does a child dispatcher speak to the user, only to its creator, or both? (Decision 1.)

## Verification note

The repo imports no dsh types; every dsh face is a hand-written structural interface. **`npm run typecheck` cannot catch host API breakage.** Any change to these surfaces must be verified by booting against the installed dsh 0.2.1-rc.2, with a kill timer armed and evidence under `.scratch/testing/<date>-<slug>/`.
