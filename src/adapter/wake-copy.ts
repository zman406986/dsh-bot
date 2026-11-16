import { textBlocks, type ContentBlock } from "./content-blocks.js";
import type { AgentMessageWakeOrigin } from "../core/peer-types.js";
import type { PolicyLanguage } from "../core/policy/prompts.js";

/**
 * New copy only — short cue that background work is ready.
 * No reconstruction-tree wording.
 *
 * Prefer building the full wake-turn body with
 * `assembleWakeTurn` (core/policy/assembler) and passing it here;
 * this constant remains as a minimal fallback when no notices are available.
 */
export const WAKE_CUE =
  "Background workers finished. Review their results and continue the conversation.";

/**
 * New copy only — short cue that a peer message opened this turn.
 * Distinct from WAKE_CUE so a peer turn never looks like a settle wake.
 */
export const PEER_WAKE_CUE =
  "A peer assistant sent a message. Treat it as another assistant, not the user.";

/**
 * ZH face of {@link WAKE_CUE} (ticket 153, authored copy — ADR-0018 B9).
 */
export const WAKE_CUE_ZH = "后台工作者已经结束。查看它们的结果，然后继续对话。";

/** ZH face of {@link PEER_WAKE_CUE} (ticket 153). */
export const PEER_WAKE_CUE_ZH =
  "一个同伴助手发来了消息。把它当作另一个助手，而不是用户。";

/**
 * Select the settle cue face (ticket 153). Fail-closed to EN, matching
 * `resolvePolicyLanguage`.
 */
export function wakeCueFor(language: PolicyLanguage): string {
  return language === "zh" ? WAKE_CUE_ZH : WAKE_CUE;
}

/** Select the peer cue face (ticket 153). Fail-closed to EN. */
export function peerWakeCueFor(language: PolicyLanguage): string {
  return language === "zh" ? PEER_WAKE_CUE_ZH : PEER_WAKE_CUE;
}

/**
 * Ticket 138 (owner ruling 2026-10-22): the payload of the cold-resume call
 * that wakes a marked dispatcher nobody had re-announced yet. Ticket 142
 * sends the same cue as the dormant-worker payload, so it names no lane:
 * a dispatcher's message arrives from its peer inbox, a worker's as a steer,
 * and both land as the next turn (ticket 154 ruling, 2026-10-28).
 *
 * It carries NO peer text on purpose. The host's `sendMessage` both resumes
 * the absent child and opens its turn, so this cue is what that turn sees;
 * the actual peer message is drained from the wake bus once the child is
 * live, as its own peer turn (`composeWakeText` → `assemblePeerWakeTurn`).
 * Sending the text here as well would deliver it twice.
 */
export const RESUME_WAKE_CUE =
  "Your session was resumed because another agent sent you a message. That message is not part of this cue; it arrives as the next turn.";

/** ZH face of {@link RESUME_WAKE_CUE} (ticket 153, authored copy). */
export const RESUME_WAKE_CUE_ZH =
  "你的会话被恢复，是因为另一个代理给你发了消息。那条消息不在这个提示里；它会在下一个回合到达。";

/** Select the resume cue face (ticket 153). Fail-closed to EN. */
export function resumeWakeCueFor(language: PolicyLanguage): string {
  return language === "zh" ? RESUME_WAKE_CUE_ZH : RESUME_WAKE_CUE;
}

export const PLUGIN_NAME = "multitask-dispatcher";

/**
 * Producer-owned message source kind.
 *
 * Session format v4 rejects the retired shared `kind: "plugin"` wrapper and
 * requires a non-empty producer-owned kind (`dsh-session-format-v3-to-v4`:
 * `"format v4 message requires a producer-owned source kind"`). The migration
 * maps a released plugin wrapper to `plugin:<package name>`, so this value is
 * exactly what our old messages become after migration.
 */
export const WAKE_SOURCE_KIND = `plugin:${PLUGIN_NAME}`;

/**
 * Ticket 116 / ADR-0025: structured provenance for a wake opened by another
 * agent. One declaration lives in core (`peer-types.ts`) so the wake bus,
 * the host port, and this message builder cannot drift; this alias exists
 * for the adapter-facing name.
 *
 * The shape is the host's own adjacent-agent source
 * (`dsh-subagent/lib/index.js:444-449`), admitted by the v4 source rules
 * (`dsh-session-format-v3-to-v4/lib/index.js:70` lists `agent-message` as a
 * released producer kind). It replaces the plugin kind on such a wake, so
 * the durable record — not the heading — says where the turn came from.
 */
export type WakeMessageSource = AgentMessageWakeOrigin;

/**
 * Structural UserMessage for `Agent.followup`.
 * Mirrors the installed `dsh-llm` shape without importing host packages.
 * Omitting `form` is valid — undeclared context is the documented default.
 */
export interface WakeUserMessage {
  readonly id: string;
  readonly role: "user";
  readonly content: ContentBlock[];
  readonly source: {
    readonly kind: string;
    readonly form?: string;
    readonly senderSessionId?: string;
    /**
     * Ticket 295: the one-line account a `form: "notice"` message puts on its
     * collapsed chat row (the host's own `model-selection` / `action-cards`
     * notices carry this field). Ignored for every other form.
     */
    readonly summary?: string;
  };
}

/**
 * Ticket 295: the visible, MODEL-FREE notice that carries activation
 * confirmation.
 *
 * WHY this shape: `/dsh-bot` announced success only as a command result, and
 * the chat renders a command result as one collapsed line whose body exists
 * solely when the text contains a newline
 * (`dsh-client-ui-chat/lib/client.js:8489`, installed package). Our 208-char
 * confirmation has none, so the user could never read it. A `user/message`
 * with `form: "notice"` and a `summary` renders as a compact context row
 * whose one-line account is always visible and whose body is the full text
 * (`:5690-5696`, `:5652-5655`).
 *
 * WHY `session.append` and not a wake: `agent.followup` is the next-turn
 * inbox plus the wake driver (`dsh-agent-loop/lib/index.js:570-572`,
 * `:618-632`), i.e. it starts a model turn. `session.append("user/message",
 * …, { surfaceOp: "append" })` is the same surface write the loop performs
 * (`:865`) without the inbox and without the wake
 * (`dsh-session/lib/index.js:1524-1535`, `:442-445`); ADR-0032:56 records
 * exactly that property. Nothing derives origin or intent from this text.
 */
let wakeMessageSeq = 0;

/**
 * Build one visible `form: "notice"` message. The id prefix distinguishes the
 * activation confirmation from the restart-honesty notice while both keep the
 * same producer-owned source (ticket 295 / ticket 298 queue).
 */
export function noticeMessage(
  idPrefix: string,
  text: string,
  summary: string,
): WakeUserMessage {
  wakeMessageSeq += 1;
  return {
    id: `${idPrefix}-${Date.now()}-${wakeMessageSeq}`,
    role: "user",
    content: textBlocks(text),
    source: { kind: WAKE_SOURCE_KIND, form: "notice", summary },
  };
}

/** The /dsh-bot activation confirmation notice (ticket 295). */
export function activationNoticeMessage(
  text: string,
  summary: string,
): WakeUserMessage {
  return noticeMessage("multitask-activation-notice", text, summary);
}

/**
 * The restart-honesty notice (ticket 31). It rides the same visible surface
 * write as the activation notice but is queued until the first real user
 * message after activation, so it never opens a turn of its own.
 */
export function restartNoticeMessage(
  text: string,
  summary: string,
): WakeUserMessage {
  return noticeMessage("multitask-restart-notice", text, summary);
}

/**
 * Build the user turn a `/dsh-bot` message argument starts.
 *
 * `source.kind: "user"` is the host's own marker for a human prompt
 * (`dsh-api-session-controller/lib/index.js:4054-4060`): the chat renders it
 * as the user's message rather than a context/notice row, and the lifecycle's
 * `user/message` listener counts it as the first real user message that opens
 * the deferred restart-notice gate (ticket 31). No `form` is declared: a
 * notice row is a structured context presentation, while this source must
 * stay an ordinary human message.
 */
export function userTurnMessage(text: string): WakeUserMessage {
  wakeMessageSeq += 1;
  return {
    id: `multitask-user-turn-${Date.now()}-${wakeMessageSeq}`,
    role: "user",
    content: textBlocks(text),
    source: { kind: "user" },
  };
}

/**
 * Build the wake follow-up message. Fresh id per call.
 *
 * `source` (ticket 116) is an optional override: a peer wake passes the
 * structured `agent-message` origin so the turn is attributed to its sender
 * agent, while a settle/plugin wake keeps the producer-owned plugin kind.
 * `text` stays presentation only — nothing derives origin from it.
 */
export function wakeUserMessage(
  text: string = WAKE_CUE,
  source?: WakeMessageSource,
): WakeUserMessage {
  wakeMessageSeq += 1;
  return {
    id: `multitask-wake-${Date.now()}-${wakeMessageSeq}`,
    role: "user",
    content: textBlocks(text),
    source:
      source !== undefined
        ? {
            kind: source.kind,
            form: source.form,
            senderSessionId: source.senderSessionId,
          }
        : { kind: WAKE_SOURCE_KIND },
  };
}
