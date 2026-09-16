import { textBlocks, type ContentBlock } from "./content-blocks.js";

/**
 * New copy only — short cue that background work is ready.
 * No Sand/reconstruction wording.
 */
export const WAKE_CUE =
  "Background workers finished. Review their results and continue the conversation.";

export const PLUGIN_NAME = "multitask-dispatcher";

/**
 * Structural UserMessage for `Agent.followup`.
 * Mirrors the installed `dsh-llm` shape without importing host packages.
 * Source uses `kind: "plugin"` without a ContextFormed discriminator
 * (omitting `form` is valid — undeclared context is the documented default).
 */
export interface WakeUserMessage {
  readonly id: string;
  readonly role: "user";
  readonly content: ContentBlock[];
  readonly source: {
    readonly kind: "plugin";
    readonly plugin: string;
  };
}

let wakeMessageSeq = 0;

/** Build the wake follow-up message. Fresh id per call. */
export function wakeUserMessage(): WakeUserMessage {
  wakeMessageSeq += 1;
  return {
    id: `multitask-wake-${Date.now()}-${wakeMessageSeq}`,
    role: "user",
    content: textBlocks(WAKE_CUE),
    source: {
      kind: "plugin",
      plugin: PLUGIN_NAME,
    },
  };
}
