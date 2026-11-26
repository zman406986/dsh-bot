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
  PEER_ROSTER_EMPTY_LINE,
  PEER_ROSTER_EMPTY_LINE_ZH,
  PEER_ROSTER_FRESHNESS_LINE,
  PEER_ROSTER_FRESHNESS_LINE_ZH,
  PEER_ROSTER_INTRO,
  PEER_ROSTER_INTRO_ZH,
  PEER_ROSTER_SECTION_HEADING,
  PEER_ROSTER_SECTION_HEADING_ZH,
  PEER_ROSTER_SUPERSEDE_LINE,
  PEER_ROSTER_SUPERSEDE_LINE_ZH,
  PEER_WAKE_SECTION_HEADINGS,
  PEER_WAKE_SECTION_HEADINGS_ZH,
  REMINDER_SECTION_HEADINGS,
  REMINDER_SECTION_HEADINGS_ZH,
  WAKE_RE_PRESENTED_HEADING,
  WAKE_RE_PRESENTED_HEADING_ZH,
  WAKE_RE_PRESENTED_INTRO,
  WAKE_RE_PRESENTED_INTRO_ZH,
  WAKE_SECTION_HEADINGS,
  WAKE_SECTION_HEADINGS_ZH,
  type DispatcherOrigin,
  type PolicyLanguage,
} from "./prompts.js";
import {
  ledgerRowSignature,
  rememberReminderSignatures,
  reminderSignaturesForSession,
  sharedReminderDeltaStore,
  type ReminderDeltaStore,
} from "./reminder-delta.js";

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
 * One landed-but-undelivered item shown again in a later wake. It carries
 * the todo id so the dispatcher can close the right ledger entry, and the
 * real report read from the settle record — never the empty-report
 * placeholder that a synthesized first-time notice would render.
 */
export interface RePresentedNotice {
  readonly todoId: string;
  readonly workerId: string;
  readonly title: string;
  readonly status: TerminalWorkerStatus;
  readonly report: string;
  readonly transcriptRef: string | null;
  /**
   * Redrive attempts spent on the todo when this wake was composed. The
   * first re-presentation (attempt 1) still renders the full report; an
   * attempt count of 2 or more renders the compact stub instead, because
   * the report was already shown in the earlier attempt. Absent means
   * "unknown" and keeps the pre-stub full rendering.
   */
  readonly redriveAttempts?: number;
  /**
   * Force the compact stub regardless of {@link redriveAttempts}. Set by the
   * composer's identical-wake backstop: a payload byte-identical to the last
   * composed wake for this session would only repeat text already on the
   * transcript, so its report is replaced by the one-line stub.
   */
  readonly stub?: boolean;
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
 * Canonical status order for collapsed delta summaries. Fixed rather than
 * first-seen so the same ledger produces the same bytes regardless of row
 * order; every status a todo row can carry is listed.
 */
const LEDGER_SUMMARY_STATUS_ORDER = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
  "lost",
] as const;

/**
 * Render the ledger section lines.
 *
 * No session key -> the legacy full ledger on every call (unit tests and
 * keyless callers keep the old bytes). With a session key, the first reminder
 * in that session is the full ledger; later reminders show only new/changed
 * rows at full fidelity and fold unchanged rows into one
 * `status (unchanged): ids` line per status, so every id is still named.
 */
function renderReminderLedger(
  todos: readonly TodoItem[],
  language: PolicyLanguage,
  sessionKey: string | undefined,
  store: ReminderDeltaStore,
): string[] {
  if (sessionKey === undefined) {
    return todos.length === 0
      ? [`- ${EMPTY_LEDGER_LINE}`]
      : todos.map(formatLedgerLine);
  }

  const previous = reminderSignaturesForSession(sessionKey, store);
  if (previous === undefined) {
    rememberReminderSignatures(todos, sessionKey, store);
    return todos.length === 0
      ? [`- ${EMPTY_LEDGER_LINE}`]
      : todos.map(formatLedgerLine);
  }

  if (todos.length === 0) {
    rememberReminderSignatures(todos, sessionKey, store);
    return [`- ${EMPTY_LEDGER_LINE}`];
  }

  const changed: TodoItem[] = [];
  const unchanged: TodoItem[] = [];
  for (const todo of todos) {
    if (previous.get(todo.id) === ledgerRowSignature(todo)) {
      unchanged.push(todo);
    } else {
      changed.push(todo);
    }
  }
  rememberReminderSignatures(todos, sessionKey, store);
  return [
    ...changed.map(formatLedgerLine),
    ...renderUnchangedLedgerSummary(unchanged, language),
  ];
}

/** One summary line per distinct status, naming every collapsed id. */
function renderUnchangedLedgerSummary(
  todos: readonly TodoItem[],
  language: PolicyLanguage,
): string[] {
  const lines: string[] = [];
  for (const status of LEDGER_SUMMARY_STATUS_ORDER) {
    const entries = todos
      .filter((todo) => todo.status === status)
      .map(formatLedgerSummaryEntry);
    if (entries.length === 0) continue;
    lines.push(
      language === "zh"
        ? `- ${status}（未变）：${entries.join("、")}`
        : `- ${status} (unchanged): ${entries.join(", ")}`,
    );
  }
  return lines;
}

/**
 * One collapsed row: the id plus the same reason annotation the full row
 * would carry. A lost row always keeps a token so a collapsed lost obligation
 * never reads like an ordinary id in a list.
 */
function formatLedgerSummaryEntry(todo: TodoItem): string {
  if (todo.status === "lost") {
    const reason = todo.dispositionReason ?? todo.disposition ?? "lost";
    return `${todo.id} (${reason})`;
  }
  if (todo.disposition !== null && todo.disposition !== "delivered") {
    return `${todo.id} (${todo.dispositionReason ?? todo.disposition})`;
  }
  return todo.id;
}

/**
 * Per-turn reminder: ledger + standing rules, then the peer roster as the
 * LAST section (ticket 121 / ADR-0027 decision 2).
 *
 * Empty ledger still injects the rules; ledger line becomes `(empty)`.
 *
 * `origin` (ticket 175 / ADR-0034) selects which class's standing rules the
 * session reads. It defaults to `"user"`, so every existing caller and test
 * keeps producing the chief-of-staff bytes.
 *
 * `sessionKey` turns the ledger into a per-session delta: the first reminder
 * renders every row, later ones render new/changed rows and a compact summary
 * of the rest. Omitting it keeps the legacy full-ledger bytes on every call.
 * `deltaStore` exists for isolated tests; production call sites share the
 * process-wide store so all three reminder paths agree on the baseline.
 *
 * Tail placement is load-bearing: the roster is appended after every stable
 * rule, and the bytes before it are produced by the same array join whether
 * or not peers exist. Adding the roster therefore cannot shift a single
 * byte of the cached prefix; removing it restores the exact old text.
 *
 * FRESHNESS, three distinct shapes (never conflated):
 * - a SUPPLIED snapshot renders its section (non-empty rows, or the heading
 *   plus {@link PEER_ROSTER_EMPTY_LINE} with zero rows);
 * - `null` means the caller did not compute a roster (the wake composer
 *   passes `null`), so the reminder ends with the neutral
 *   {@link PEER_ROSTER_SUPERSEDE_LINE} — freshness only, no heading, no claim
 *   that a roster follows and no claim that nobody is visible;
 * - `undefined` (the no-argument helper call) emits no roster text at all.
 * This is forward-only: the host replays committed user messages after a
 * restart, so an old roster block can remain above this turn, and nothing
 * here can delete, compact, or rewrite it. The newest reminder stating which
 * one is current is the only correction available.
 */
export function assembleTurnReminder(
  todos: readonly TodoItem[],
  peers?: PeerRosterSnapshot | null,
  language: PolicyLanguage = "en",
  origin: DispatcherOrigin = "user",
  sessionKey?: string,
  deltaStore: ReminderDeltaStore = sharedReminderDeltaStore,
): string {
  const headings =
    language === "zh" ? REMINDER_SECTION_HEADINGS_ZH : REMINDER_SECTION_HEADINGS;
  const ledgerLines = renderReminderLedger(
    todos,
    language,
    sessionKey,
    deltaStore,
  );
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
  } else if (peers === null) {
    // Wake composer: no roster was computed on this turn (it passes `null`),
    // yet the replayed log may still carry an old "Other agents" block above.
    // Freshness only — no heading, no rows, and no claim about who is visible,
    // because nobody looked. The most recent real roster stays the authority.
    sections.push("");
    sections.push(
      language === "zh" ? PEER_ROSTER_SUPERSEDE_LINE_ZH : PEER_ROSTER_SUPERSEDE_LINE,
    );
  } else if (peers !== undefined) {
    // The caller DID compute a roster and it lists nobody. Say so in a FRESH
    // zero-row section that carries the same "this one is current"
    // instruction: a replayed old roster block may sit above this turn, and a
    // reminder that rendered nothing would supersede nothing.
    sections.push("");
    sections.push(
      language === "zh" ? PEER_ROSTER_SECTION_HEADING_ZH : PEER_ROSTER_SECTION_HEADING,
    );
    sections.push("");
    sections.push(
      language === "zh" ? PEER_ROSTER_EMPTY_LINE_ZH : PEER_ROSTER_EMPTY_LINE,
    );
  }
  // `undefined` (the no-argument helper call) emits nothing: the caller of
  // that shape did not ask about peers at all.
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
 * and are already visible in the ledger and through the stock `list_agents`, so
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
 * that text (ticket 121). `null`/empty roster returns the input unchanged
 * (byte-identical).
 *
 * No shipped caller uses this helper today: the live wake path gets its
 * roster inside {@link assembleTurnReminder}, where the roster is already the
 * reminder's tail, and appending it again here would duplicate the section.
 * It stays as the sanctioned placement for a future composer whose body has
 * blocks after the reminder (`reminder + wake + inbox`); that composer must
 * then build the reminder WITHOUT a roster snapshot, or dedupe it itself.
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
  // Fixed supersede marker, after the rows: this section is the current one,
  // so every replayed "Other agents" block above it is stale. Constant bytes,
  // so an unchanged roster still renders identically on every turn.
  lines.push("");
  lines.push(
    language === "zh"
      ? PEER_ROSTER_FRESHNESS_LINE_ZH
      : PEER_ROSTER_FRESHNESS_LINE,
  );
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
 * Distinct re-presentation section: these results were already shown, and
 * are still not delivered. The block exists so a repeated wake cannot read
 * as a fresh first-time settle and cannot fall back to the empty-report
 * placeholder.
 */
function appendRePresentedSection(
  sections: string[],
  items: readonly RePresentedNotice[],
  language: PolicyLanguage,
): void {
  if (items.length === 0) return;
  const zh = language === "zh";
  sections.push("");
  sections.push(
    zh ? WAKE_RE_PRESENTED_HEADING_ZH : WAKE_RE_PRESENTED_HEADING,
  );
  sections.push("");
  sections.push(zh ? WAKE_RE_PRESENTED_INTRO_ZH : WAKE_RE_PRESENTED_INTRO);
  for (const item of items) {
    sections.push("");
    sections.push(`### ${item.title} — ${item.status}`);
    sections.push(`${zh ? "待办" : "Todo"}: ${item.todoId}`);
    sections.push(`${zh ? "工作者" : "Worker"}: ${item.workerId}`);
    // Reuse the notice's pointer exactly as the full form does; a missing one
    // renders the same explicit "(none)" rather than inventing a reference.
    sections.push(
      item.transcriptRef !== null
        ? `${zh ? "记录" : "Transcript"}: ${item.transcriptRef}`
        : `${zh ? "记录" : "Transcript"}: ${zh ? "（无）" : "(none)"}`,
    );
    const attempts = item.redriveAttempts;
    const stub = item.stub === true || (attempts !== undefined && attempts >= 2);
    if (stub) {
      // Repeated result: keep the identity/address lines so the dispatcher
      // can still close the right ledger entry, but not one byte of the
      // report body — it is already on the transcript from the first
      // re-presentation (or superseded by this wake's own instruction). The
      // honest "no longer held in this process" fallback belongs only to the
      // full form, which is the one that shows a body.
      const retry = attempts === undefined
        ? ""
        : zh
          ? `（第 ${attempts} 次重试）`
          : ` (redrive attempt ${attempts})`;
      sections.push("");
      sections.push(
        zh
          ? `报告已在更早的唤醒中展示过，此处不再重复${retry}。`
          : `The report was already shown in an earlier wake and is not repeated here${retry}.`,
      );
      continue;
    }
    sections.push("");
    // A completed report from the settle record is already clamped, with its
    // truncation marker carrying the ORIGINAL shown/total counts. Re-clamping
    // it here would append a second marker and understate the real report
    // length. Error bodies still need their status-aware label.
    sections.push(
      item.status === "completed"
        ? item.report
        : formatWakeReportBody(item.status, item.report, item.transcriptRef),
    );
  }
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
  rePresented: readonly RePresentedNotice[] = [],
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

  appendRePresentedSection(sections, rePresented, language);

  sections.push("");
  sections.push(buildWakeInstructionsBlock(language, origin));
  return sections.join("\n");
}

/**
 * Hidden-turn body for a peer wake (ticket 14 / design-14 §4).
 * New copy only. The cue marks the turn as another assistant — never
 * the user. Tests assert cue tokens and structure, not full prose.
 *
 * `origin` (ticket 175) reaches both instruction blocks: a team leader's
 * worker reply must report upward to its summoner, not to its own user, so
 * the class selects a worker-reply variant too.
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
      // A dispatcher sender's `fromName` IS its session id, so `name (id)`
      // would print the same value twice. Omit the parenthetical then; the
      // id remains the heading's visible address either way.
      sections.push(
        notice.fromName === notice.fromAgentId
          ? `### ${notice.fromAgentId}`
          : `### ${notice.fromName} (${notice.fromAgentId})`,
      );
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
  // The selected block supplies its own "What to do now" heading; pushing
  // `headings[2]` here would render the heading twice.
  // A wake carrying only worker replies is not peer traffic: its senders are
  // this dispatcher's own workers, and the peer block's silence rule would
  // bury a `blocked` dead-end report — the one message that needs a decision.
  // Mixed wakes keep the peer block, whose rules cover both senders.
  sections.push(
    notices.length > 0 && notices.every(isWorkerReply)
      ? buildWorkerReplyWakeInstructionsBlock(language, origin)
      : buildPeerWakeInstructionsBlock(language, origin),
  );
  return sections.join("\n");
}
