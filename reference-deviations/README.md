# Reference deviations — index

229 deviation records (`DD-001` … `DD-229`), one per difference found between **the build** and **the reference**.

- **The build** is this repository: the TypeScript Cordis plugin **multitask-dispatcher** (the dsh / DeepSeek Harness multitask dispatcher — an always-on dispatcher that stays responsive by delegating non-trivial work to blank background workers). Its code lives under `src/` (`core/`, `adapter/`, `client/`, `worker/`) with a web client surface under `client/`.
- **The reference** is the compared product: an Electron/React desktop agent app, **Grok Bot 0.18**, kept read-only at `reference material-NOT LICENSE SAFE DONT COPY-grok bot/`. That tree carries its own `.git` and is never modified.

**Method.** Survey areas were found by read-only passes over both trees; each deviation was then written as its own record, and every record was independently verified before it was filed. Nothing in the reference tree is copied, and nothing here is a port plan.

**Template.** Every record has the same shape: a title line; `Area` / `Type` / `Date` bullets; then `## What the reference does`, `## What the current build does`, `## The deviation`, `## Verdict: <word>`, `## Incorporation notes` (where it would live, constraints, license note, effort/risk, key reference anchors), and `## Evidence` (reference paths and build paths, with line numbers).

**Verdict vocabulary.** Four words, used exclusively:

| Verdict | Meaning |
|---|---|
| **INCORPORATE** | Worth adopting as-is. |
| **ADAPT** | Worth adopting in modified form. |
| **DO-NOT-INCORPORATE** | Recorded as excluded or inapplicable — a decision, not an oversight. |
| **ASK-HUMAN** | Needs a human ruling, usually because the authority stack does not settle it. |

**License discipline (ADR-0018 exception B9).** The reference tree is a public reconstruction with unknown upstream provenance, so no verbatim copying of source, prompts, tool strings, identifiers or protocol artifacts is permitted; adapted copying — restructured, independently named, not textually identical — is. Every record therefore paraphrases the reference **by role** and cites paths and line numbers instead of transcribing code.

**Authority stack.** Where a ruling exists, a record cites it and says so explicitly; where none does, the record says that too and reaches ASK-HUMAN rather than inventing one. The most frequently cited are ADR-0018's exception list (among others A4 no-send-journal, A5 no second database, C14 no org-chart/routines/memory, C15 single wake kind, U-A no account gates, U-B no rich chat ergonomics, U-D no settings-managed rule store), plus ADR-0006 (storage), ADR-0010 (honesty), ADR-0011 (consent never widens), ADR-0012 (restart replays durability, never work), ADR-0020 (shell non-goal) and ADR-0021/0022 (the single additive extension point and the floating window).

**Scope note.** Remote computer use — the reference's remote-machine feature and its internals — was excluded from the study by request. Rich chat ergonomics, account/privacy gates, and the org-chart/routines/memory class were excluded where a recorded ruling already covers them (those exclusions are still recorded, as DO-NOT-INCORPORATE).

## Index

All 229 records, grouped by survey area in DD order (the area code is the survey's own enumeration; the Area column quotes the label as written in the file). DD numbers link to the record.

### A1 — UI shell / window chrome (15 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-001](DD-001-native-window-chrome.md) | Native window chrome vs DOM floating panel | UI shell / window chrome (A1) | DO-NOT-INCORPORATE |
| [DD-002](DD-002-window-state-persistence.md) | Window placement persistence vs in-memory-only placement | UI shell / window chrome (A1) | ASK-HUMAN |
| [DD-003](DD-003-navigation-history.md) | Agent-selection navigation history vs click-only selection | UI shell / window chrome (A1) | ADAPT |
| [DD-004](DD-004-notification-host.md) | In-window notification tray vs none | UI shell / window chrome (A1) | DO-NOT-INCORPORATE |
| [DD-005](DD-005-modal-alerts-and-destructive-confirmation.md) | Modal alert host vs inline two-press confirmations | UI shell / window chrome (A1) + sidebar management (A11) | ADAPT |
| [DD-006](DD-006-root-error-boundary.md) | App-wide fatal error surface vs per-open window boundary | UI shell / window chrome (A1) | ADAPT |
| [DD-007](DD-007-workspace-states.md) | Workspace loading/empty/connection states vs plain copy | UI shell / window chrome (A1) | ASK-HUMAN |
| [DD-008](DD-008-status-badge.md) | Transport status badge vs absent | UI shell / window chrome (A1) | DO-NOT-INCORPORATE |
| [DD-009](DD-009-workspace-indicator.md) | Chrome-level active-agent indicator vs in-window header | UI shell / window chrome (A1) | ADAPT |
| [DD-010](DD-010-aux-overlay-stack.md) | Auxiliary overlay stack vs one additive seam | UI shell / window chrome (A1) | DO-NOT-INCORPORATE |
| [DD-011](DD-011-sidebar-layout.md) | Resizable/collapsible persisted sidebar vs fixed grid | UI shell / window chrome (A1) | ADAPT |
| [DD-012](DD-012-zoom.md) | Zoom-factor plumbing vs absent | UI shell / window chrome (A1) | DO-NOT-INCORPORATE |
| [DD-013](DD-013-fullscreen-state.md) | OS fullscreen state tracking vs DOM-maximize only | UI shell / window chrome (A1) | DO-NOT-INCORPORATE |
| [DD-014](DD-014-theme-ownership.md) | Theme ownership: reference self-themed engine vs host-token inheritance | UI shell / window chrome (A1) | DO-NOT-INCORPORATE |
| [DD-015](DD-015-os-intent-seams.md) | OS-to-shell intent plumbing vs none (grouped) | UI shell / window chrome (A1) | ASK-HUMAN |

### A2 — Keyboard shortcuts (3 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-016](DD-016-no-global-shortcut-registry.md) | Global shortcut registry vs none | keyboard shortcuts (A2) | ADAPT |
| [DD-017](DD-017-escape-overlay-semantics.md) | Centralized Escape-overlay semantics vs unguarded local dismiss | keyboard shortcuts (A2) | ADAPT |
| [DD-018](DD-018-shortcut-mechanics.md) | Shortcut mechanics machinery vs none | keyboard shortcuts (A2) | ADAPT |

### A3 — Command palette (3 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-019](DD-019-command-palette-absent.md) | Command palette ("Jump to") vs none | command palette (A3) | DO-NOT-INCORPORATE |
| [DD-020](DD-020-slash-command-affordance.md) | Zero-typing palette commands vs slash commands in the stock composer | command palette (A3) | DO-NOT-INCORPORATE |
| [DD-021](DD-021-palette-multi-provider-search.md) | Palette fuzzy multi-provider search vs no search surface | command palette (A3) | ADAPT |

### A4 — Transcript delivery states (16 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-022](DD-022-optimistic-echo-delivery-model.md) | Send-journal delivery states and optimistic echo vs direct sends | transcript delivery states (A4) | DO-NOT-INCORPORATE |
| [DD-023](DD-023-queued-notice-cancel.md) | Queued-send notice with Cancel vs none | transcript delivery states (A4) | DO-NOT-INCORPORATE |
| [DD-024](DD-024-failed-send-resend-delete.md) | Failed-send Resend/Delete actions vs keep-draft error line | transcript delivery states (A4) | DO-NOT-INCORPORATE |
| [DD-025](DD-025-reactions.md) | Message reactions (pills, picker, feed) vs none | transcript delivery states (A4) / message cards (A10) | DO-NOT-INCORPORATE |
| [DD-026](DD-026-replies-and-reply-targeting.md) | Replies and reply-targeting pipeline vs none | transcript delivery states (A4) / composer (A9) | ASK-HUMAN |
| [DD-027](DD-027-threads.md) | Threads (affordance, counts, open/summary lifecycle) vs none | transcript delivery states (A4) / message cards (A10) | DO-NOT-INCORPORATE |
| [DD-028](DD-028-message-action-anchor.md) | Per-message action anchor (hover toolbar + context menu) vs none | transcript delivery states (A4) | ADAPT |
| [DD-029](DD-029-copy-message.md) | Message/code-block copy affordances vs none | transcript delivery states (A4) | ADAPT |
| [DD-030](DD-030-adjacency-grouping.md) | Turn adjacency/grouping & bubbles vs flat list | transcript delivery states (A4) | ADAPT |
| [DD-031](DD-031-streaming-presentation.md) | Streaming presentation: animated dots vs text busy marker | transcript delivery states (A4) | ADAPT |
| [DD-032](DD-032-pagination-auto-load.md) | Auto load-older with states vs manual silent button | transcript delivery states (A4) | DO-NOT-INCORPORATE |
| [DD-033](DD-033-load-error-retry.md) | Transcript load-error surface with Retry vs static unavailable notice | transcript delivery states (A4) | DO-NOT-INCORPORATE |
| [DD-034](DD-034-sent-while-offline.md) | "Composed while offline" timestamp notice vs none | transcript delivery states (A4) | DO-NOT-INCORPORATE |
| [DD-035](DD-035-time-unread-separators.md) | Time separators and unread divider vs none | transcript delivery states (A4) | ASK-HUMAN |
| [DD-037](DD-037-interrupted-addition.md) | Build-only "interrupted" marker (inverted deviation) | transcript delivery states (A4) | ASK-HUMAN |
| [DD-038](DD-038-log-semantics.md) | Transcript a11y semantics (role=log/article) vs plain divs | transcript delivery states (A4) | INCORPORATE |

### A5 — Rich rendering (8 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-039](DD-039-assistant-markdown-blocks.md) | Structured assistant markdown blocks vs raw pre-wrap text | rich rendering (A5) | ASK-HUMAN |
| [DD-040](DD-040-inline-markdown.md) | Inline markdown formatting & autolinks vs literal text | rich rendering (A5) | INCORPORATE |
| [DD-041](DD-041-math-katex.md) | KaTeX math rendering vs literal delimiters | rich rendering (A5) | ASK-HUMAN |
| [DD-042](DD-042-mermaid-diagrams.md) | Mermaid diagram rendering + viewer vs literal fences | rich rendering (A5) | DO-NOT-INCORPORATE |
| [DD-043](DD-043-code-blocks-copy.md) | Fenced code blocks with per-block copy vs plain lines | rich rendering (A5) | ASK-HUMAN |
| [DD-044](DD-044-user-rich-text.md) | User rich-text rendering (persisted ProseMirror doc) vs plain text | rich rendering (A5) | ASK-HUMAN |
| [DD-045](DD-045-viewer-suite.md) | Attachment viewer suite (media/PDF/spreadsheet) vs attachment-only marker | rich rendering (A5) | DO-NOT-INCORPORATE |
| [DD-046](DD-046-find-in-chat.md) | Find-in-chat vs none | rich rendering (A5) | DO-NOT-INCORPORATE |

### A6 — Composer editor (14 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-047](DD-047-editor-framework.md) | Rich-text editor framework vs plain textarea | composer editor (A6) | DO-NOT-INCORPORATE |
| [DD-048](DD-048-placeholder-behavior.md) | Composer placeholder copy & empty-state vs none | composer editor (A6) | INCORPORATE |
| [DD-049](DD-049-mention-suggestion.md) | @-mention suggestion machinery vs none | composer editor (A6) | ADAPT |
| [DD-050](DD-050-slash-workflow-suggestion.md) | "/" skill-reference suggestion listbox vs manual slash text | composer editor (A6) | ASK-HUMAN |
| [DD-051](DD-051-pr-reference-suggestion.md) | "#" pull-request reference chips vs none | composer editor (A6) | DO-NOT-INCORPORATE |
| [DD-052](DD-052-emoji-suggestion.md) | ":" emoji picker listbox vs none | composer editor (A6) | INCORPORATE |
| [DD-053](DD-053-rich-text-serialization.md) | Dual plain/rich send serialization vs verbatim plain text | composer editor (A6) | DO-NOT-INCORPORATE |
| [DD-054](DD-054-send-affordance-swap.md) | Mic/send glyph swap vs static text Send button | composer editor (A6) | ADAPT |
| [DD-055](DD-055-pending-disabled-state.md) | Composer freeze during send vs stay-editable editor | composer editor (A6) | ADAPT |
| [DD-056](DD-056-escape-key-contract.md) | Composer Escape contract (cancel voice / blur) vs unhandled | composer editor (A6) | ADAPT |
| [DD-057](DD-057-focus-management.md) | Composer focus management & paste-refocus vs none | composer editor (A6) | ADAPT |
| [DD-058](DD-058-caret-scroll-motion.md) | Caret scroll & emacs line-motion plugins vs native textarea behavior | composer editor (A6) | DO-NOT-INCORPORATE |
| [DD-059](DD-059-a11y-field-attrs.md) | Composer field a11y attributes vs mislabeled textarea | composer editor (A6) | INCORPORATE |
| [DD-060](DD-060-build-only-error-line.md) | Build-only honest send-failure status line (inverted deviation) | composer editor (A6) | INCORPORATE |

### A7 — Composer attachments (4 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-061](DD-061-attachments-absent-with-limit.md) | Hard-capped attachment intake vs text-only sends | composer attachments (A7) | DO-NOT-INCORPORATE |
| [DD-062](DD-062-dragdrop-overlay.md) | Drag-and-drop file intake with overlay vs none | composer attachments (A7) | DO-NOT-INCORPORATE |
| [DD-063](DD-063-paste-staging.md) | Clipboard paste with staged upload lifecycle vs none | composer attachments (A7) | DO-NOT-INCORPORATE |
| [DD-064](DD-064-chips-notices.md) | Attachment chips & staging notices vs none | composer attachments (A7) | DO-NOT-INCORPORATE |

### A8 — Voice dictation (2 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-065](DD-065-voice-absent.md) | Mic dictation vs none | voice dictation (A8) | ASK-HUMAN |
| [DD-066](DD-066-voice-transport-host-rpc.md) | Voice transcription transport: host-RPC vs no channel | voice dictation (A8) | ADAPT |

### A9 — Composer drafts (2 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-036](DD-036-draft-persistence-scope.md) | Persisted per-agent composer drafts vs ephemeral component state | composer drafts (A9) | DO-NOT-INCORPORATE |
| [DD-067](DD-067-draft-id-recovery-fork.md) | Draft identity, recovery slot & targeted clearing vs unconditional clear | composer drafts (A9) | ADAPT |

### A10 — Message cards (15 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-068](DD-068-card-registry-system.md) | Card registry/protocol/frame system vs ad-hoc card surfaces | message cards (A10) | DO-NOT-INCORPORATE |
| [DD-069](DD-069-email-draft-card.md) | In-transcript email draft card vs none | message cards (A10) | ADAPT |
| [DD-070](DD-070-slack-draft-card.md) | In-transcript Slack draft card vs none | message cards (A10) | DO-NOT-INCORPORATE |
| [DD-071](DD-071-widget-question-card.md) | Interactive question widget card vs access-ask cards only | message cards (A10) | ASK-HUMAN |
| [DD-072](DD-072-link-card.md) | Bare-URL link preview card vs plain text | message cards (A10) | DO-NOT-INCORPORATE |
| [DD-073](DD-073-attachment-card.md) | In-transcript attachment card vs attachment-only marker | message cards (A10) | DO-NOT-INCORPORATE |
| [DD-074](DD-074-listener-connect-card.md) | Integration listener-connect card vs none | message cards (A10) | DO-NOT-INCORPORATE |
| [DD-075](DD-075-connector-cards.md) | Connector install/authorize cards vs none | message cards (A10) | ADAPT |
| [DD-076](DD-076-secret-request-flow.md) | Secret request: value-provision form vs name-only permission ask | message cards (A10) / approval flows (A28) | ASK-HUMAN |
| [DD-077](DD-077-auto-review-approval-card.md) | In-transcript approval card affordances vs Needs-you section cards | message cards (A10) | ADAPT |
| [DD-078](DD-078-permission-cards.md) | In-transcript permission prompt cards vs none | message cards (A10) | ADAPT |
| [DD-079](DD-079-timeline-events.md) | Timeline event rows vs none | message cards (A10) | DO-NOT-INCORPORATE |
| [DD-080](DD-080-notice-cards.md) | Distinct notice card vs plain text lines | message cards (A10) | DO-NOT-INCORPORATE |
| [DD-081](DD-081-tool-result-cards.md) | Rich tool-result cards (output/diff/status) vs compact toolview rows | message cards (A10) | ADAPT |
| [DD-082](DD-082-cursor-agent-card-slot.md) | Reserved cursor-agent card slot vs none | message cards (A10) | ADAPT |

### A11 — Sidebar / roster / agent management (15 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-083](DD-083-row-identity-rename.md) | Renameable agent identity vs read-only host session titles | sidebar / roster / agent management (A11) | ADAPT |
| [DD-084](DD-084-avatars-generated-personas.md) | Agent avatars & generated persona marks vs presence dot | sidebar / roster / agent management (A11) | ASK-HUMAN |
| [DD-085](DD-085-pinning.md) | Pinned rail with drag reorder vs fixed dispatcher-first order | sidebar / roster / agent management (A11) | ADAPT |
| [DD-086](DD-086-custom-sections.md) | User-defined sidebar sections vs fixed dispatcher partition | sidebar / roster / agent management (A11) | ASK-HUMAN |
| [DD-087](DD-087-row-context-menu-breadth.md) | Ten-item row context menu vs one-item Close dispatcher menu | sidebar / roster / agent management (A11) | ADAPT |
| [DD-088](DD-088-hide-hidden-overlay.md) | Hide-from-sidebar with recovery overlay vs permanent row drop | sidebar / roster / agent management (A11) | ADAPT |
| [DD-089](DD-089-failure-recovery-affordances.md) | Interactive retry/reconnect surfaces vs retry-less honest states | sidebar / roster / agent management (A11) | DO-NOT-INCORPORATE |
| [DD-090](DD-090-privacy-blocked-dialog.md) | Privacy-blocked roster dialog vs none | sidebar / roster / agent management (A11) | DO-NOT-INCORPORATE |
| [DD-091](DD-091-multiselect-bulk-operations.md) | Multi-select with bulk actions vs single selection | sidebar / roster / agent management (A11) | ASK-HUMAN |
| [DD-092](DD-092-agent-info-cluster.md) | Per-agent info surfaces (profile/channels/members/tasks) vs none | sidebar / roster / agent management (A11) | ASK-HUMAN |
| [DD-093](DD-093-org-chart-network.md) | Org-chart agent network + inspector vs none | sidebar / roster / agent management (A11) | DO-NOT-INCORPORATE |
| [DD-094](DD-094-sidebar-header-tools.md) | Sidebar header tool cluster vs static title + add picker | sidebar / roster / agent management (A11) | DO-NOT-INCORPORATE |
| [DD-095](DD-095-presence-vocabulary.md) | Per-agent presence vocabulary vs session-aggregate presence | sidebar / roster / agent management (A11) | ADAPT |
| [DD-096](DD-096-ui-state-persistence.md) | Persisted UI preferences (pins/selection/layout) vs in-memory only | sidebar / roster / agent management (A11) | ASK-HUMAN |
| [DD-097](DD-097-deletion-semantics.md) | Destructive delete (agent + history) vs non-destructive unbind | sidebar / roster / agent management (A11) | DO-NOT-INCORPORATE |

### A12 — Settings (10 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-098](DD-098-settings-surface-architecture.md) | Self-owned multi-section settings modal vs single card in host settings | settings (A12) | DO-NOT-INCORPORATE |
| [DD-099](DD-099-general-section-settings.md) | General settings group (theme/timezone/permission/security/account) vs two plugin controls | settings (A12) | DO-NOT-INCORPORATE |
| [DD-100](DD-100-router-usage-billing.md) | Router/provider choice + usage meters vs none | settings (A12) | DO-NOT-INCORPORATE |
| [DD-101](DD-101-updates-section.md) | Update settings group vs none | settings (A12) | DO-NOT-INCORPORATE |
| [DD-102](DD-102-auto-review-editor.md) | Auto-review rules editor vs boolean/number-only settings card | settings (A12) | ASK-HUMAN |
| [DD-103](DD-103-mcp-per-server-settings.md) | Per-server MCP settings (instructions/tool toggles) vs none | settings (A12) | ADAPT |
| [DD-104](DD-104-versioning-migrations.md) | Versioned settings store with migrations vs host-schema document | settings (A12) | ADAPT |
| [DD-105](DD-105-save-semantics.md) | Staged Save/Discard settings vs immediate persist-per-control | settings (A12) | DO-NOT-INCORPORATE |
| [DD-106](DD-106-session-freeze-enabled.md) | Frozen per-session `enabled` flag vs live-applied settings | settings (A12) | DO-NOT-INCORPORATE |
| [DD-107](DD-107-misc-store-keys.md) | Remaining store keys with no build counterpart (grouped) | settings (A12) | DO-NOT-INCORPORATE |

### A13 — Onboarding (7 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-108](DD-108-onboarding-flow-structure.md) | Interactive guided onboarding flow vs five static beats | onboarding (A13) | ADAPT |
| [DD-109](DD-109-suggestion-catalog-absent.md) | Persona suggestion catalog vs no catalog | onboarding (A13) | ADAPT |
| [DD-110](DD-110-create-step-makes-agent.md) | Onboarding create step that spawns an agent vs instructional copy | onboarding (A13) | DO-NOT-INCORPORATE |
| [DD-111](DD-111-character-customization.md) | Character/scene customization vs text-and-dots pane | onboarding (A13) | DO-NOT-INCORPORATE |
| [DD-112](DD-112-seen-persistence.md) | Onboarding "seen" persistence mechanism vs plugin-namespace record | onboarding (A13) | ADAPT |
| [DD-113](DD-113-rerun-and-skip-intents.md) | Onboarding re-run/force intents vs none | onboarding (A13) | ADAPT |
| [DD-114](DD-114-skip-and-back-semantics.md) | Skip-forward vs Back-navigation onboarding footer (inverted delta) | onboarding (A13) | ADAPT |

### A14 — Auth / account / secrets (7 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-115](DD-115-sign-in-gating.md) | Whole-shell sign-in/access gate vs none | auth / account / secrets (A14) | DO-NOT-INCORPORATE |
| [DD-116](DD-116-account-session.md) | Account session surface (menu/status/sign-out) vs none | auth / account / secrets (A14) | DO-NOT-INCORPORATE |
| [DD-117](DD-117-login-flow-machinery.md) | OS-level login machinery vs none | auth / account / secrets (A14) | DO-NOT-INCORPORATE |
| [DD-118](DD-118-credential-renewal.md) | Inference-credential renewal service vs host-owned tokens | auth / account / secrets (A14) | DO-NOT-INCORPORATE |
| [DD-119](DD-119-secret-storage.md) | OS-keychain secret store vs name-only relay posture | auth / account / secrets (A14) | DO-NOT-INCORPORATE |
| [DD-120](DD-120-secrets-provisioning.md) | Secrets provisioning pipeline (env injection / vault bridge) vs none | auth / account / secrets (A14) | DO-NOT-INCORPORATE |
| [DD-121](DD-121-webauthn-security-keys.md) | WebAuthn security-key ceremonies vs none | auth / account / secrets (A14) | DO-NOT-INCORPORATE |

### A15 — Inference routing & streaming (9 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-122](DD-122-provider-routing-sessions.md) | Per-turn provider routing vs host-owned inference | inference routing & streaming (A15) | DO-NOT-INCORPORATE |
| [DD-123](DD-123-routed-transcript-store.md) | Router-owned routed-transcript store vs transcriptRef pointers | inference routing & streaming (A15) | DO-NOT-INCORPORATE |
| [DD-124](DD-124-projection-rich-fields.md) | Rich-field transcript projection vs text-only reduction | inference routing & streaming (A15) | DO-NOT-INCORPORATE |
| [DD-125](DD-125-streaming-ownership.md) | Delta-streaming event protocol vs host event-window tail | inference routing & streaming (A15) | DO-NOT-INCORPORATE |
| [DD-126](DD-126-middleware-pipeline.md) | Executor middleware chain vs no middleware seam | inference routing & streaming (A15) | DO-NOT-INCORPORATE |
| [DD-127](DD-127-token-limit-classification.md) | Typed token-limit error classification vs coarse stop-reason mapping | inference routing & streaming (A15) | ADAPT |
| [DD-128](DD-128-effort-model-selection.md) | Reasoning-effort & model-selection machinery vs host defaults | inference routing & streaming (A15) | ADAPT |
| [DD-129](DD-129-composing-activity-synthesis.md) | Fabricated composing activity vs observed-truth activity | inference routing & streaming (A15) | DO-NOT-INCORPORATE |
| [DD-130](DD-130-provider-failure-entry.md) | Synthetic error transcript entries vs settle-event error reporting | inference routing & streaming (A15) | DO-NOT-INCORPORATE |

### A16 — Agent runner / turn execution (9 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-131](DD-131-turn-shell-guards.md) | Generation-guarded turn shell & pause/quiesce states vs none | agent runner / turn execution (A16) | ASK-HUMAN |
| [DD-132](DD-132-max-steps-bound.md) | Per-turn step ceiling vs none | agent runner / turn execution (A16) | ADAPT |
| [DD-133](DD-133-stream-retry-stall.md) | Transient stream retry & first-token stall deadlines vs host-owned attempts | agent runner / turn execution (A16) | ASK-HUMAN |
| [DD-134](DD-134-background-work-kinds.md) | Background shell/cloud watches vs single wake family | agent runner / turn execution (A16) | DO-NOT-INCORPORATE |
| [DD-135](DD-135-completion-revivals.md) | Hidden completion-revival turns vs visible dispatcher wake turns | agent runner / turn execution (A16) | ADAPT |
| [DD-136](DD-136-pending-wake-store.md) | Durable pending-wake store & boot re-arm vs marker rebuild | agent runner / turn execution (A16) | DO-NOT-INCORPORATE |
| [DD-137](DD-137-interrupt-cascade.md) | Parent-interrupt cascade & background drain vs per-worker stop only | agent runner / turn execution (A16) | ASK-HUMAN |
| [DD-138](DD-138-liveness-addition-mcp-stall.md) | Liveness addition vs MCP stall diagnostic (mixed) | agent runner / turn execution (A16) | DO-NOT-INCORPORATE |
| [DD-139](DD-139-observation-telemetry-depth.md) | Turn observation instrumentation depth vs minimal counters | agent runner / turn execution (A16) | ADAPT |

### A17 — System prompts / persona (9 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-140](DD-140-identity-framing.md) | Branded persona identity with self-modification vs functional role labels | system prompts / persona (A17) | DO-NOT-INCORPORATE |
| [DD-141](DD-141-monolith-vs-section.md) | Monolithic persona prompt vs additive policy section | system prompts / persona (A17) | DO-NOT-INCORPORATE |
| [DD-142](DD-142-proactive-initiative.md) | Anticipatory-initiative persona section vs reactive-only policy | system prompts / persona (A17) | ADAPT |
| [DD-143](DD-143-communication-style.md) | Tone & reply-shape prompt sections vs thin style clauses | system prompts / persona (A17) | INCORPORATE |
| [DD-144](DD-144-reply-first-rhythm.md) | Ack-first turn rhythm with silence policing vs no turn-rhythm copy | system prompts / persona (A17) | ADAPT |
| [DD-145](DD-145-personalization-memory.md) | Rich per-turn injected context vs ledger-only dynamic content | system prompts / persona (A17) | DO-NOT-INCORPORATE |
| [DD-146](DD-146-monitoring-stance.md) | Mid-flight supervision orders vs no-poll wake-driven stance | system prompts / persona (A17) | DO-NOT-INCORPORATE |
| [DD-147](DD-147-safety-persona.md) | Persona-level fabrication/security/authority rules vs worker-only safety copy | system prompts / persona (A17) | ADAPT |
| [DD-148](DD-148-language-style-matching.md) | Ghostwriting voice-matching & language rules vs none | system prompts / persona (A17) | ADAPT |

### A18 — Prompt sections (8 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-149](DD-149-autonomous-git-etiquette.md) | Autonomous git/PR duty prompt family vs none | prompt sections (A18) | ASK-HUMAN |
| [DD-150](DD-150-git-safety-protocol.md) | On-demand commit/PR protocol sections vs none | prompt sections (A18) | ADAPT |
| [DD-151](DD-151-agentsmd-injection.md) | AGENTS.md project-instruction injection into prompts | A18 prompt sections | ASK-HUMAN |
| [DD-152](DD-152-project-conversation-type.md) | Project conversation type (a first-class project-agent role with a durable store) | A18 prompt sections | ASK-HUMAN |
| [DD-153](DD-153-multitask-reminder-vs-ledger-reminder.md) | Multitask-mode user reminder vs the build's ledger reminder | A18 prompt sections | ASK-HUMAN |
| [DD-154](DD-154-user-info-environment-section.md) | Environment/user-info section in the system prompt | A18 prompt sections | ADAPT |
| [DD-155](DD-155-composed-rule-library.md) | Composed per-model rule library (conditional rule sections) | A18 prompt sections | DO-NOT-INCORPORATE |
| [DD-156](DD-156-mcp-and-skill-catalogs.md) | MCP and skill catalogs in the prompt (discovery, budgets, degradation) | A18 prompt sections | ASK-HUMAN |

### A19 — Tool surface (10 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-157](DD-157-tool-registry-governance.md) | Central tool registry and per-agent tool governance | A19 tool surface | DO-NOT-INCORPORATE |
| [DD-158](DD-158-task-tool-parameter-surface.md) | Task/spawn tool parameter surface | A19 tool surface | ASK-HUMAN |
| [DD-159](DD-159-task-tool-description-guidance.md) | Task tool description: guidance depth and when-not-to-use | A19 tool surface | ADAPT |
| [DD-160](DD-160-subagent-management-tools.md) | Subagent management tools: check / message / stop and their not-running feedback | A19 tool surface | ADAPT |
| [DD-161](DD-161-resume-versus-terminal-work.md) | Resume / self-fork / interrupt vs the build's terminal-work stance | A19 tool surface | DO-NOT-INCORPORATE |
| [DD-162](DD-162-inter-agent-messaging-surface.md) | Inter-agent messaging surface: deliver/peer tools vs the reference's send surface | A19 tool surface | ASK-HUMAN |
| [DD-163](DD-163-ask-question-tool.md) | Ask-question tool: multi-question support and anti-nag behavior | A19 tool surface | ASK-HUMAN |
| [DD-164](DD-164-todo-tool-vs-internal-ledger.md) | Todo tool vs the build's core-internal ledger | A19 tool surface | DO-NOT-INCORPORATE |
| [DD-165](DD-165-shell-tool-ownership.md) | Shell tool ownership: reference-owned vs host-owned | A19 tool surface | DO-NOT-INCORPORATE |
| [DD-166](DD-166-subagent-preparation-pipeline.md) | Subagent preparation pipeline vs prompt-string-alone spawning | A19 tool surface | DO-NOT-INCORPORATE |

### A20 — Session & durability (10 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-167](DD-167-per-agent-durable-session-store.md) | Per-agent durable session store vs the build's in-memory agent map | A20 session & durability | DO-NOT-INCORPORATE |
| [DD-168](DD-168-agent-count-cap-and-fallback-session.md) | Agent-count cap and fallback session minting | A20 session & durability | DO-NOT-INCORPORATE |
| [DD-169](DD-169-awaiting-user-response-state.md) | Awaiting-user-response state and pending-card expiry | A20 session & durability | ASK-HUMAN |
| [DD-170](DD-170-conversation-size-limits-and-gc.md) | Conversation size limits and garbage collection | A20 session & durability | DO-NOT-INCORPORATE |
| [DD-171](DD-171-send-acceptance-ledger.md) | Send-acceptance ledger (durable digest of accepted sends) | A20 session & durability | DO-NOT-INCORPORATE |
| [DD-172](DD-172-redelivery-mechanisms.md) | Redelivery: hidden ack-obligation redrive vs the build's visible-turn redrive | A20 session & durability | ADAPT |
| [DD-173](DD-173-restart-resume-vs-never-replay.md) | Restart handling: quiesce-and-resume vs rebuild-and-never-replay | A20 session & durability | DO-NOT-INCORPORATE |
| [DD-174](DD-174-wake-kind-taxonomy.md) | Wake taxonomy: six durable wake kinds vs the build's single wake family | A20 session & durability | DO-NOT-INCORPORATE |
| [DD-175](DD-175-group-sessions-and-shared-rooms.md) | Group sessions and shared rooms | A20 session & durability | DO-NOT-INCORPORATE |
| [DD-176](DD-176-maintenance-recovery-and-projection.md) | Session maintenance, database recovery, summaries, and roster projection | A20 session & durability | DO-NOT-INCORPORATE |

### A21 — Storage (6 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-177](DD-177-storage-architecture.md) | Storage architecture: per-agent store DB plus blob store vs the build's marker durability | A21 storage | DO-NOT-INCORPORATE |
| [DD-178](DD-178-transcript-mirror.md) | On-disk transcript mirror with WAL-style checkpoints | A21 storage | DO-NOT-INCORPORATE |
| [DD-179](DD-179-conversation-content-search.md) | Conversation content search (full-text index over stored conversations) | A21 storage | DO-NOT-INCORPORATE |
| [DD-180](DD-180-client-persisted-ui-slices.md) | Client-persisted UI slices vs the build's ephemeral floating-window state | A21 storage | ASK-HUMAN |
| [DD-181](DD-181-store-sync-and-box-transfer.md) | Agent-store sync and box transfer | A21 storage | DO-NOT-INCORPORATE |
| [DD-182](DD-182-json-config-stores.md) | Atomic JSON config stores for coordinator and app settings | A21 storage | DO-NOT-INCORPORATE |

### A22 — Automation (5 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-183](DD-183-routines-subsystem-absent.md) | Routines/automations subsystem absent | A22 automation | DO-NOT-INCORPORATE |
| [DD-184](DD-184-proactive-automation-stance.md) | Proactive automation stance: proposing routines, cadence policy, self-expiring watches | A22 automation | DO-NOT-INCORPORATE |
| [DD-185](DD-185-trigger-taxonomy.md) | Trigger taxonomy: cron, interval, and third-party integrations | A22 automation | DO-NOT-INCORPORATE |
| [DD-186](DD-186-routines-ui-panel.md) | Routines UI: schedule editor, trigger schema, and run history | A22 automation | DO-NOT-INCORPORATE |
| [DD-187](DD-187-automation-numeric-limits.md) | Automation numeric limits and clamps | A22 automation | DO-NOT-INCORPORATE |

### A23 — Memory (4 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-188](DD-188-memory-feature-absent.md) | Per-agent memory feature absent | A23 memory | DO-NOT-INCORPORATE |
| [DD-189](DD-189-memory-synthesis-service.md) | Memory synthesis service (evidence-cited proposal and verification) | A23 memory | DO-NOT-INCORPORATE |
| [DD-190](DD-190-memory-on-disk-format.md) | Memory on-disk format (profile, monthly log, ids, tombstones, shards) | A23 memory | DO-NOT-INCORPORATE |
| [DD-191](DD-191-memory-prompt-injection.md) | Memory prompt injection (bounded memory sections in the system prompt) | A23 memory | DO-NOT-INCORPORATE |

### A24 — Context management (6 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-192](DD-192-llm-context-summarization.md) | LLM-driven context summarization (nine-section prompt with fallback) | A24 context management | DO-NOT-INCORPORATE |
| [DD-193](DD-193-background-summarization.md) | Background summarization with multiple trigger modes | A24 context management | DO-NOT-INCORPORATE |
| [DD-194](DD-194-token-estimation.md) | Token estimation (heuristic budget accounting) vs raw character caps | A24 context management | DO-NOT-INCORPORATE |
| [DD-195](DD-195-durable-block-preservation.md) | Durable-block preservation across compaction | A24 context management | DO-NOT-INCORPORATE |
| [DD-196](DD-196-self-summarization.md) | Self-summarization (agent compacts its own context) | A24 context management | DO-NOT-INCORPORATE |
| [DD-197](DD-197-loop-detection.md) | Loop detection: periodic-repeat detector vs the build's visibility-only liveness | A24 context management | DO-NOT-INCORPORATE |

### A25 — Attachments & media (6 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-198](DD-198-attachment-upload-lifecycle.md) | Attachment staging and upload lifecycle vs path-string forwarding | A25 attachments & media | DO-NOT-INCORPORATE |
| [DD-199](DD-199-chunked-reads-and-downloads.md) | Chunked attachment reads and a download leg | A25 attachments & media | DO-NOT-INCORPORATE |
| [DD-200](DD-200-link-metadata-pipeline.md) | Link metadata (unfurl) pipeline with cache and SSRF hardening | A25 attachments & media | DO-NOT-INCORPORATE |
| [DD-201](DD-201-model-boundary-image-handling.md) | Model-boundary image handling: resize, re-encode, and drop-to-placeholder | A25 attachments & media | ASK-HUMAN |
| [DD-202](DD-202-attachment-kind-classification.md) | Attachment kind classification and per-kind handling tables | A25 attachments & media | DO-NOT-INCORPORATE |
| [DD-229](DD-229-video-rendition-cache.md) | Video playback rendition cache (probe, transcode, LRU, refcount) | A25 attachments & media | DO-NOT-INCORPORATE |

### A26 — MCP machinery (5 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-203](DD-203-mcp-server-lifecycle-and-management.md) | MCP server configuration, lifecycle, and management surface | A26 MCP machinery | ASK-HUMAN |
| [DD-204](DD-204-mcp-oauth-credential-forwarding.md) | MCP OAuth: browser sign-in, loopback callback capture, and credential forwarding | A26 MCP machinery | ASK-HUMAN |
| [DD-205](DD-205-mcp-transports-and-supervision.md) | MCP transports and transport supervision | A26 MCP machinery | ASK-HUMAN |
| [DD-206](DD-206-mcp-tool-invocation-pipeline.md) | MCP tool exposure and invocation pipeline | A26 MCP machinery | ASK-HUMAN |
| [DD-207](DD-207-mcp-isolation-and-permissions.md) | Isolation and permission gates around MCP execution | A26 MCP machinery | ASK-HUMAN |

### A27 — Platform integration (6 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-208](DD-208-native-menu-bar-and-accelerators.md) | Native application menu bar and main-process accelerator routing | A27 platform integration | DO-NOT-INCORPORATE |
| [DD-209](DD-209-os-push-notification-stack.md) | OS-level push notification stack (delivery, click-through, badge, mobile relay) | A27 platform integration | DO-NOT-INCORPORATE |
| [DD-210](DD-210-deep-links.md) | Deep links: protocol registration, argv extraction, single-instance forwarding | A27 platform integration | DO-NOT-INCORPORATE |
| [DD-211](DD-211-app-lifecycle-and-single-instance.md) | App lifecycle and single-instance enforcement | A27 platform integration | DO-NOT-INCORPORATE |
| [DD-212](DD-212-power-sleep-and-idle-sensing.md) | Power, sleep/wake, and idle sensing as platform inputs | A27 platform integration | DO-NOT-INCORPORATE |
| [DD-213](DD-213-crash-reporting-and-log-spill.md) | Crash/error reporting, unclean-exit detection, and structured log spill | A27 platform integration | DO-NOT-INCORPORATE |

### A28 — Approval & policy (8 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-214](DD-214-local-tool-permission-model.md) | Local-tool permission model: three-state setting, admin ceiling, four-way resolution | A28 approval & policy | DO-NOT-INCORPORATE |
| [DD-215](DD-215-durable-approval-records.md) | Durable approval records, retirement, and refusal memory | A28 approval & policy | DO-NOT-INCORPORATE |
| [DD-216](DD-216-auto-review-enforcement-modes.md) | Auto-review enforcement modes and per-surface gating | A28 approval & policy | DO-NOT-INCORPORATE |
| [DD-217](DD-217-approval-lifecycle-and-expiry.md) | Approval lifecycle: expiry taxonomy, pending caps, generation checks | A28 approval & policy | ADAPT |
| [DD-218](DD-218-notification-configuration-and-preferences.md) | Notification configuration and per-agent notify preferences | A28 approval & policy | DO-NOT-INCORPORATE |
| [DD-219](DD-219-file-based-permission-policy.md) | File-based permission policy: user and workspace policy documents | A28 approval & policy | DO-NOT-INCORPORATE |
| [DD-220](DD-220-auto-review-classifier-pipeline.md) | Auto-review classifier pipeline: instruction lists, decision shape, redaction | A28 approval & policy | DO-NOT-INCORPORATE |
| [DD-221](DD-221-updater.md) | Updater: check, download, verify, stage, apply, tracks, managed gate | A28 approval & policy | DO-NOT-INCORPORATE |

### A29 — Cross-cutting surfaces (7 records)

| DD | Title | Area | Verdict |
|---|---|---|---|
| [DD-222](DD-222-command-palette.md) | Command palette: fuzzy-ranked, tabbed quick-action surface | A29 cross-cutting surfaces | DO-NOT-INCORPORATE |
| [DD-223](DD-223-in-app-search-affordances.md) | In-app search affordances: find-in-chat and per-provider palette search | A29 cross-cutting surfaces | DO-NOT-INCORPORATE |
| [DD-224](DD-224-runtime-theming.md) | Runtime theming: dual-mode token installer vs the build's host-token-only doctrine | A29 cross-cutting surfaces | DO-NOT-INCORPORATE |
| [DD-225](DD-225-accessibility-infrastructure.md) | Accessibility infrastructure: live-region announcements and focus management | A29 cross-cutting surfaces | ADAPT |
| [DD-226](DD-226-error-surfaces-and-connection-state.md) | Error surfaces: a designed failure view and a connection-state controller | A29 cross-cutting surfaces | ADAPT |
| [DD-227](DD-227-performance-instrumentation.md) | Performance instrumentation: startup phases, render and stream metrics, process sampling | A29 cross-cutting surfaces | ADAPT |
| [DD-228](DD-228-quality-infrastructure.md) | Quality infrastructure: graph-aware audits gating the build | A29 cross-cutting surfaces | ADAPT |

### Verdict tally

**Verdict tally (229 records):** INCORPORATE 7 · ADAPT 57 · DO-NOT-INCORPORATE 126 · ASK-HUMAN 39  
Every record carries exactly one verdict word; the four are exclusive and sum to 229.

## Checked and found equivalent, out of scope, or build-ahead

Not everything compared became a record. These findings are part of the study and are recorded here so the same areas are not surveyed twice:

- **Composer Enter-key contract and clear-on-accept.** Examined and found **equivalent** between the two trees; not filed.
- **Mid-flight steering of a worker.** Examined and **ruled not a deviation** (recorded in the study register as D-7 / ticket 60); not filed.
- **Worker-dispatch cards in the build's UI.** A **build-only addition** with no reference analog; not filed as a deviation.
- **Peer-message length handling.** The reference clamps over-long peer messages; the build refuses them inline with an explicit ceiling, and additionally adds peer deduplication and inbox caps the reference lacks (`src/core/peer-inbox.ts`). These contrasts are recorded inside the relevant records rather than as separate files.
- **The ~38-state scene catalog figure** in one early survey was **hedged** — approximate, not verified — and should not be cited as a hard number.
- **Internationalization: the build is ahead.** The build has a real locale layer (English and Chinese faces registered through the host, with every visible string routed through locale keys — e.g. the `locale` inject in `src/client/index.ts`), while the reference is hardcoded-English. Checked, and not a deviation in the build's disfavor.
- **Onboarding: present in both.** The build ships an onboarding flow (`src/client/onboarding.ts`, `src/client/onboarding-pane.tsx`); the reference's is richer. Recorded as a depth difference, not an absence, and not filed.
- **In-app docs/help surface.** Too thin in the reference to file as a deviation.
- **The MCP family (DD-203 … DD-207)** all turn on the same open scope question — whether MCP is host territory for this plugin — so they were filed consistently rather than re-arguing the question in each file.
- **DD-222 and DD-223** were written late in the study as cross-cutting framings and cross-reference the records that own the same ground (DD-019 / DD-021 / DD-046 for palette and search); they cover only what is different and re-file nothing.

## How to read this folder

1. **Start with the ASK-HUMAN records** — they are the open decisions, and the only ones that need a human ruling before anything else can move.
2. **Then INCORPORATE and ADAPT** — the actionable set. Each record's `Incorporation notes` say where the change would live, what constrains it, and the effort/risk.
3. **DO-NOT-INCORPORATE is not a to-do list** — it is the recorded exclusions, and its job is to stop settled questions from being reopened. Read one before proposing anything in its area.

Each record cites the authority stack where a ruling exists, and says so explicitly when none does — an ASK-HUMAN verdict usually means no ruling covers the question, not that the answer is unknown. Records also carry their own verification status: the `Evidence` section distinguishes what was read in full from what was cited from another record's survey.
