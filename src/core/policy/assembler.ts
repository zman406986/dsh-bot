/**
 * Pure policy assemblers for the dispatcher (new copy only).
 * Feature flag is read once at dispatcher-session start (ADR-0005):
 * flag OFF → empty session policy; tools are not registered.
 * Tests assert structure/order, not prose quality.
 */

import { isWorkerReply, peerTargetLabel, type PeerNotice } from "../peer-types.js";
import { clampActivity, formatWakeReportBody, TOOL_RESULT_SUMMARY_MAX_ROWS } from "../report-clamp.js";
import type { TodoItem } from "../todo-reconciler.js";
import type { TerminalWorkerStatus } from "../types.js";
import type { SettledWorkerNotice } from "../wake-bus.js";
import {
  buildDispatcherPolicySection,
  buildPeerWakeInstructionsBlock,
  buildStandingRulesBlock,
  buildWakeInstructionsBlock,
  buildWorkerReplyWakeInstructionsBlock,
  EMPTY_LEDGER_LINE,
  PEER_ROSTER_INTRO,
  PEER_ROSTER_INTRO_ZH,
  PEER_ROSTER_SECTION_HEADING,
  PEER_ROSTER_SECTION_HEADING_ZH,
  PEER_WAKE_SECTION_HEADINGS,
  PEER_WAKE_SECTION_HEADINGS_ZH,
  REMINDER_SECTION_HEADINGS,
  REMINDER_SECTION_HEADINGS_ZH,
  WAKE_SECTION_HEADINGS,
  WAKE_SECTION_HEADINGS_ZH,
  type DispatcherOrigin,
  type PolicyLanguage,
} from "./prompts.js";

/**
 * One settled worker carried into a wake turn.
 * `transcriptRef` may be null when the host has not recorded one.
 */
export interface WakeNotice {
  readonly workerId: string;
  readonly title: string;
  readonly status: TerminalWorkerStatus;
  readonly report: string;
  readonly transcriptRef: string | null;
}

/**
 * Session policy section. Empty string when the flag is OFF.
 *
 * `origin` (ticket 141) selects the spawned wording; omitted means `user`,
 * so every pre-141 caller produces the same bytes it always did.
 * `generation` (ticket 141) is forwarded to the spawned opener only; the
 * default is the generation of a direct child of a user-started dispatcher.
 * `language` (ticket 153) defaults to EN; only an exact shipped id selects
 * the ZH face (see `resolvePolicyLanguage`), so an unknown or absent
 * preference composes the same bytes as before.
 */
export function assembleSessionPolicy(
  enabled: boolean,
  origin: DispatcherOrigin = "user",
  generation = 2,
  language: PolicyLanguage = "en",
): string {
  if (!enabled) return "";
  return buildDispatcherPolicySection(origin, generation, language);
}

/** Render one ledger line for the per-turn reminder. */
export function formatLedgerLine(todo: TodoItem): string {
  const base = `- ${todo.id} · ${todo.status} · ${todo.title}`;
  // Ticket 58 (register D-6): a closed obligation says WHY it closed. A `lost`
  // item reading exactly like a `completed` one is the defect this exists to
  // remove. Delivered items are left alone — "(delivered)" on every finished
  // line is noise, and the absence of an annotation already means "fine".
  if (todo.disposition === null || todo.disposition === "delivered") {
    return base;
  }
  return `${base} (${todo.dispositionReason ?? todo.disposition})`;
}

/**
 * Per-turn reminder: ledger + standing rules, then the peer roster as the
 * LAST section (ticket 121 / ADR-0027 decision 2).
 *
 * Empty ledger still injects the rules; ledger line becomes `(empty)`.
 *
 * `origin` (ticket 175 / ADR-0034) selects which class's standing rules the
 * session reads. It is trailing and defaults to `"user"`, so every existing
 * caller and test keeps producing the chief-of-staff bytes.
 *
 * Tail placement is load-bearing: the roster is appended after every stable
 * rule, and the bytes before it are produced by the same array join whether
 * or not peers exist. Adding the roster therefore cannot shift a single
 * byte of the cached prefix; removing it restores the exact old text.
 */
export function assembleTurnReminder(
  todos: readonly TodoItem[],
  peers?: PeerRosterSnapshot | null,
  language: PolicyLanguage = "en",
  origin: DispatcherOrigin = "user",
): string {
  const headings =
    language === "zh" ? REMINDER_SECTION_HEADINGS_ZH : REMINDER_SECTION_HEADINGS;
  const ledgerLines =
    todos.length === 0
      ? [`- ${EMPTY_LEDGER_LINE}`]
      : todos.map(formatLedgerLine);
  const sections: string[] = [
    headings[0],
    ...ledgerLines,
    "",
    buildStandingRulesBlock(language, origin),
  ];
  const roster = renderPeerRoster(peers, language);
  if (roster !== null) {
    sections.push("");
    sections.push(roster);
  }
  return sections.join("\n");
}

// ── Peer roster tail (ticket 121 / ADR-0027) ──────────────────────────────

/**
 * Peer liveness vocabulary — ADR-0027 decision 3's `statusOf` shape. These
 * four are the whole vocabulary; any other value renders `unknown`, never a
 * coerced real state.
 */
export type PeerLiveness = "working" | "waiting" | "approval" | "idle";

/** Every real liveness value, in the ADR's stated order. */
export const PEER_LIVENESS_STATES: readonly PeerLiveness[] = [
  "working",
  "waiting",
  "approval",
  "idle",
];

const PEER_LIVENESS_SET: ReadonlySet<string> = new Set(PEER_LIVENESS_STATES);

/**
 * The observable facts a snapshot builder can read for one peer without I/O
 * (ticket 121, ADR-0027 open question 4). Each is a live-state read the
 * session already holds:
 *
 * - `busy` — that peer's dispatcher turn is running (`wakeBus.isBusy`, fed
 *   by `agent/status` for every activated dispatcher on this host).
 * - `queuedWake` — a wake is READY for it and not yet drained
 *   (`wakeBus.peek(sessionId) !== undefined`).
 *
 * Ticket 174 / ADR-0033: the `pendingApproval` fact went with the worker
 * access-ask feature. The `approval` liveness label stays in the vocabulary
 * (ADR-0027 decision 3) but no shipped producer can raise it any more.
 *
 * The host exposes no per-peer "waiting on the model" signal, so `waiting`
 * here means exactly "a wake is ready and no turn is running" — the row
 * text must not be read as a model-level wait.
 */
export interface PeerLivenessFacts {
  readonly busy: boolean;
  readonly queuedWake: boolean;
}

/**
 * Derive the liveness label from observable facts. Precedence: a running turn
 * outranks a queued wake, and no fact at all is `idle`. The `approval` label
 * stays in the vocabulary (ADR-0027 decision 3) but ticket 174 / ADR-0033
 * removed its only producer, so this function can no longer return it.
 */
export function derivePeerLiveness(facts: PeerLivenessFacts): PeerLiveness {
  if (facts.busy) return "working";
  if (facts.queuedWake) return "waiting";
  return "idle";
}

/**
 * One peer row for the roster tail (ticket 121). Identity is the session id
 * (ADR-0027 §Starting identity 1). `label` is `subagent.label`; `title` is
 * the session title; the renderer falls back label → title → session id.
 *
 * `liveness` is typed loosely on purpose: the renderer must degrade an
 * unknown vocabulary value instead of throwing, so a caller with a stale or
 * foreign status string still gets an honest `unknown` row.
 * `activity` is the existing activity-ring phrase (`tool: hint`) — never a
 * fresh timestamp.
 */
export interface PeerRosterEntry {
  readonly sessionId: string;
  readonly label?: string | null;
  readonly title?: string | null;
  readonly liveness?: string | null;
  readonly activity?: string | null;
  readonly currentTool?: string | null;
  readonly currentTarget?: string | null;
}

/**
 * The per-turn snapshot the renderer consumes. Built by the caller from live
 * state (the refresh point is per-turn prompt assembly, ADR-0027 decision 4);
 * the renderer itself is pure — no host, no I/O, no async, no clock.
 * `selfSessionId` is excluded from the rows: the dispatcher is not its own
 * peer.
 */
export interface PeerRosterSnapshot {
  readonly peers: readonly PeerRosterEntry[];
  readonly selfSessionId?: string | null;
}

/**
 * Roster cap. Reuses the shipped check-roster convention — the same 20 rows
 * `report-clamp.ts` sets for `TOOL_RESULT_SUMMARY_MAX_ROWS` — so the prompt
 * tail stays bounded no matter how many sessions exist. Overflow is stated
 * as a count line, never as a truncated row that looks complete.
 */
export const PEER_ROSTER_MAX_ROWS = TOOL_RESULT_SUMMARY_MAX_ROWS;

/** One-line normalization: collapse whitespace, trim, empty → null. */
function oneLineText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length === 0 ? null : text;
}

/** Label → title → null (the caller then uses the session id). */
function peerDisplayName(entry: PeerRosterEntry): string | null {
  return oneLineText(entry.label) ?? oneLineText(entry.title);
}

/** Known liveness value, or the honest `unknown` marker. */
function normalizePeerLiveness(
  value: string | null | undefined,
): PeerLiveness | "unknown" {
  return typeof value === "string" && PEER_LIVENESS_SET.has(value)
    ? (value as PeerLiveness)
    : "unknown";
}

/**
 * Activity suffix: the ring's latest phrase when present (already the
 * `tool: hint` vocabulary), else the explicit tool/target pair. Null when
 * nothing was observed — absence is never filled with invented text.
 */
function peerActivityPhrase(entry: PeerRosterEntry): string | null {
  const activity = oneLineText(entry.activity);
  if (activity !== null) return clampActivity(activity);
  const tool = oneLineText(entry.currentTool);
  if (tool === null) return null;
  const target = oneLineText(entry.currentTarget);
  return clampActivity(
    target === null ? `using ${tool}` : `using ${tool} on ${target}`,
  );
}

/**
 * One caller-owned candidate row: the peer facts a live-state reader already
 * holds, plus the three observable liveness booleans. The builder derives the
 * liveness label here so the caller never invents one.
 */
export interface PeerRosterCandidate {
  readonly sessionId: string;
  readonly label?: string | null;
  readonly title?: string | null;
  readonly busy?: boolean;
  readonly queuedWake?: boolean;
  readonly activity?: string | null;
  readonly currentTool?: string | null;
  readonly currentTarget?: string | null;
}

/**
 * Project live-state rows into the renderer's snapshot (ticket 121). Pure:
 * a field copy plus {@link derivePeerLiveness}; no clock, no I/O, no host
 * call. The adapter's per-turn read of busy / pending-approval / queued-wake
 * feeds this, and the result is passed to {@link assembleTurnReminder}.
 *
 * Eligibility is the CALLER's choice; the recorded choice for ticket 121 is
 * **other activated dispatcher sessions only**. Workers are leaves (ADR-0003)
 * and are already visible in the ledger and through `check_workers`, so
 * listing them would duplicate state and invite peer sends to sessions that
 * never drain a peer inbox.
 */
export function buildPeerRosterSnapshot(
  selfSessionId: string | null,
  candidates: readonly PeerRosterCandidate[],
): PeerRosterSnapshot {
  const peers: PeerRosterEntry[] = candidates.map((candidate) => ({
    sessionId: candidate.sessionId,
    label: candidate.label ?? null,
    title: candidate.title ?? null,
    liveness: derivePeerLiveness({
      busy: candidate.busy === true,
      queuedWake: candidate.queuedWake === true,
    }),
    activity: candidate.activity ?? null,
    currentTool: candidate.currentTool ?? null,
    currentTarget: candidate.currentTarget ?? null,
  }));
  return { peers, selfSessionId };
}

/**
 * Append the roster to an already-assembled text so it is the LAST section of
 * that text (ticket 121). For callers whose body is composed from several
 * blocks — the wake turn's `reminder + wake + inbox` — this puts the roster
 * at the true tail instead of inside the reminder. `null`/empty roster
 * returns the input unchanged (byte-identical).
 */
export function appendPeerRosterTail(
  text: string,
  snapshot?: PeerRosterSnapshot | null,
  language: PolicyLanguage = "en",
): string {
  const roster = renderPeerRoster(snapshot, language);
  return roster === null ? text : `${text}\n\n${roster}`;
}

/**
 * Render one peer roster section, or `null` when there is nothing to say.
 *
 * Pure and cheap: sorts a copy (deterministic by session code-unit order, so
 * the same state renders the same bytes regardless of input insertion
 * order), de-duplicates by session id (one row per session), excludes the
 * viewing session, applies the cap, and emits nothing when no eligible peer
 * remains. No timestamps, counters, durations, or clock reads — an unchanged
 * roster is byte-identical across turns.
 *
 * Provenance: the heading and intro say these are other agents, never the
 * user, matching the established `PEER_WAKE_SECTION_HEADINGS` convention.
 */
export function renderPeerRoster(
  snapshot: PeerRosterSnapshot | null | undefined,
  language: PolicyLanguage = "en",
): string | null {
  if (snapshot === null || snapshot === undefined) return null;
  const peers = snapshot.peers;
  if (!Array.isArray(peers)) return null;
  const selfSessionId =
    typeof snapshot.selfSessionId === "string"
      ? snapshot.selfSessionId
      : null;

  const seen = new Set<string>();
  const entries: PeerRosterEntry[] = [];
  for (const peer of peers) {
    if (typeof peer !== "object" || peer === null) continue;
    const sessionId = oneLineText(peer.sessionId);
    if (sessionId === null || sessionId === selfSessionId) continue;
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    entries.push({ ...peer, sessionId });
  }
  if (entries.length === 0) return null;

  entries.sort((a, b) =>
    a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0,
  );

  const shown = entries.slice(0, PEER_ROSTER_MAX_ROWS);
  const lines: string[] = [
    language === "zh" ? PEER_ROSTER_SECTION_HEADING_ZH : PEER_ROSTER_SECTION_HEADING,
    "",
    language === "zh" ? PEER_ROSTER_INTRO_ZH : PEER_ROSTER_INTRO,
    "",
    ...shown.map((entry) => {
      const name = peerDisplayName(entry);
      const who =
        name === null || name === entry.sessionId
          ? entry.sessionId
          : `${name} (${entry.sessionId})`;
      const status = normalizePeerLiveness(entry.liveness);
      const activity = peerActivityPhrase(entry);
      return activity === null
        ? `- ${who} — ${status}`
        : `- ${who} — ${status} · ${activity}`;
    }),
  ];
  if (entries.length > PEER_ROSTER_MAX_ROWS) {
    const more = entries.length - PEER_ROSTER_MAX_ROWS;
    lines.push(
      language === "zh"
        ? `- …… 还有 ${more} 个（共 ${entries.length} 个；显示 ${PEER_ROSTER_MAX_ROWS} 个）。`
        : `- … and ${more} more (${entries.length} total; ${PEER_ROSTER_MAX_ROWS} shown).`,
    );
  }
  return lines.join("\n");
}

/** Map a settle notice onto the wake-notice shape. */
export function noticeFromSettled(
  notice: SettledWorkerNotice,
  transcriptRef: string | null = null,
): WakeNotice {
  return {
    workerId: notice.workerId,
    title: notice.title,
    status: notice.status,
    report: notice.resultText,
    transcriptRef,
  };
}

/**
 * Wake-turn instructions for worker-settled hidden turns.
 * Silence is a valid outcome (stale / duplicate / irrelevant).
 *
 * `origin` (ticket 175 / ADR-0034 decision 2) selects the class's steps: a
 * team leader gets the re-chunk-and-report-upward face, a chief of staff the
 * delivery-decision face. Trailing and defaulted, so an omitted class keeps
 * the chief-of-staff bytes.
 */export function assembleWakeTurn(
  notices: readonly WakeNotice[],
  language: PolicyLanguage = "en",
  origin: DispatcherOrigin = "user",
): string {
  const zh = language === "zh";
  const headings = zh ? WAKE_SECTION_HEADINGS_ZH : WAKE_SECTION_HEADINGS;
  const sections: string[] = [
    headings[0],
    "",
    zh
      ? "你有一个或多个工作者已经结束。详情在下面。"
      : "One or more of your workers has finished. Details are below.",
    "",
    headings[1],
  ];

  if (notices.length === 0) {
    sections.push(zh ? "（无）" : "(none)");
  } else {
    for (const notice of notices) {
      sections.push("");
      sections.push(`### ${notice.title} — ${notice.status}`);
      sections.push(`${zh ? "工作者" : "Worker"}: ${notice.workerId}`);
      sections.push(
        notice.transcriptRef !== null
          ? `${zh ? "记录" : "Transcript"}: ${notice.transcriptRef}`
          : `${zh ? "记录" : "Transcript"}: ${zh ? "（无）" : "(none)"}`,
      );
      sections.push("");
      sections.push(
        formatWakeReportBody(notice.status, notice.report, notice.transcriptRef),
      );
    }
  }

  sections.push("");
  sections.push(buildWakeInstructionsBlock(language, origin));
  return sections.join("\n");
}

/**
 * Hidden-turn body for a peer wake (ticket 14 / design-14 §4).
 * New copy only. The cue marks the turn as another assistant — never
 * the user. Tests assert cue tokens and structure, not full prose.
 *
 * `origin` (ticket 175) reaches the peer block only. The worker-reply block
 * below stays class-free on purpose: ticket 170 still owns it, and the
 * ticket-175 out-of-scope list records the surviving defect there (a team
 * leader's blocked-worker reply should also point upward).
 */
export function assemblePeerWakeTurn(
  notices: readonly PeerNotice[],
  language: PolicyLanguage = "en",
  origin: DispatcherOrigin = "user",
): string {
  const zh = language === "zh";
  const headings = zh
    ? PEER_WAKE_SECTION_HEADINGS_ZH
    : PEER_WAKE_SECTION_HEADINGS;
  const sections: string[] = [
    `# ${headings[0]}`,
    "",
    zh
      ? "这个回合由同伴收件箱打开。下面的文字不是来自用户。"
      : "This turn was opened by the peer inbox. The text below is not from the user.",
    "",
    headings[1],
  ];

  if (notices.length === 0) {
    sections.push("");
    sections.push(zh ? "（无）" : "(none)");
  } else {
    for (const notice of notices) {
      sections.push("");
      sections.push(`### ${notice.fromName} (${notice.fromAgentId})`);
      sections.push(
        `- ${zh ? "目标" : "Target"}: ${peerTargetLabel(notice.to)}`,
      );
      // Ticket 70 §3: `conversationId` is FENCED — kept in the schema,
      // never surfaced (a threading concept is U-B-excluded). The reply
      // address a peer turn needs is the sender's session id above.
      sections.push(
        `- ${zh ? "优先级" : "Priority"}: ${notice.priority ? (zh ? "是" : "yes") : zh ? "否" : "no"}`,
      );
      sections.push(`- ${zh ? "收到时间" : "Received"}: ${notice.createdAtMs}`);
      sections.push(
        `- ${zh ? "消息 id" : "Message id"}: ${notice.messageId}`,
      );
      sections.push("");
      sections.push(notice.text);
    }
  }

  sections.push("");
  sections.push(headings[2]);
  sections.push("");
  // A wake carrying only worker replies is not peer traffic: its senders are
  // this dispatcher's own workers, and the peer block's silence rule would
  // bury a `blocked` dead-end report — the one message that needs a decision.
  // Mixed wakes keep the peer block, whose rules cover both senders.
  sections.push(
    notices.length > 0 && notices.every(isWorkerReply)
      ? buildWorkerReplyWakeInstructionsBlock(language)
      : buildPeerWakeInstructionsBlock(language, origin),
  );
  return sections.join("\n");
}
