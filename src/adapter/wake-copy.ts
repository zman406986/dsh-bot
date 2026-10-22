import { textBlocks, type ContentBlock } from "./content-blocks.js";
import type { AgentMessageWakeOrigin } from "../core/peer-types.js";

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
 * Ticket 138 (owner ruling 2026-10-22): the payload of the cold-resume call
 * that wakes a marked dispatcher nobody had re-announced yet.
 *
 * It carries NO peer text on purpose. The host's `sendMessage` both resumes
 * the absent child and opens its turn, so this cue is what that turn sees;
 * the actual peer message is drained from the wake bus once the child is
 * live, as its own peer turn (`composeWakeText` → `assemblePeerWakeTurn`).
 * Sending the text here as well would deliver it twice.
 */
export const RESUME_WAKE_CUE =
  "Your session was resumed because another agent sent you a message. That message is not part of this cue; it arrives as the next turn, from your peer inbox.";

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
  };
}

let wakeMessageSeq = 0;

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
