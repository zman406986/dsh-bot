import { textBlocks, type ContentBlock } from "./content-blocks.js";

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
  };
}

let wakeMessageSeq = 0;

/** Build the wake follow-up message. Fresh id per call. */
export function wakeUserMessage(text: string = WAKE_CUE): WakeUserMessage {
  wakeMessageSeq += 1;
  return {
    id: `multitask-wake-${Date.now()}-${wakeMessageSeq}`,
    role: "user",
    content: textBlocks(text),
    source: {
      kind: WAKE_SOURCE_KIND,
    },
  };
}
