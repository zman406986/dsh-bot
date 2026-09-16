/**
 * Host slash-command registration for dispatcher activation (ticket 19,
 * ADR-0009). The plugin boots dormant and stock; this command is the only
 * visible affordance until the user opts a chat in.
 *
 * All copy below is original clean-room text (design-16 §6).
 * Structural only — no import of `@deepseek-ai/dsh-commands` (peer surface).
 */

import type {
  AdapterContext,
  AgentLike,
  CommandDefinitionLike,
  CommandResultLike,
} from "./cordis-dsh-host.js";
import type { ActivationOutcome } from "./parent-agent.js";

/** Globally unique host command name (`dispatcher-` prefix, design-16 §5). */
export const DISPATCHER_START_COMMAND = "dispatcher-start";

/** Command menu description. */
export const DISPATCHER_START_DESCRIPTION =
  "Turn this chat into the multitask dispatcher for this session.";

/** Success copy shown in the activated chat. */
export const DISPATCHER_START_SUCCESS =
  "Dispatcher active in this chat. Workers spawned here report back here; " +
  "use /dispatcher-steer to nudge a running worker.";

/** Same chat is already the dispatcher. */
export const DISPATCHER_START_ALREADY_HERE =
  "The dispatcher is already active in this chat.";

/** Another chat holds the single dispatcher slot for this session. */
export const DISPATCHER_START_ALREADY_ELSEWHERE =
  "The dispatcher is already active in another chat. Finish or clear that " +
  "session first.";

/** Invoked in a child/delegated chat. */
export const DISPATCHER_START_NOT_TOP_LEVEL =
  "The dispatcher can only be activated in a top-level chat.";

/** The invocation carried no resolvable live agent (refuse, never guess). */
export const DISPATCHER_START_UNRESOLVED =
  "Could not resolve the current chat for activation. Re-run this command " +
  "from the chat you want to use as the dispatcher.";

/** Structured refusal for dispatcher tools called outside the activated chat. */
export const DISPATCHER_TOOL_GATE_REFUSAL =
  "Dispatcher tools are only available in the activated dispatcher chat. " +
  "Run /dispatcher-start there first.";

export interface RegisterDispatcherStartCommandOptions {
  readonly ctx: AdapterContext;
  /** Current dispatcher session id, or null while dormant. */
  readonly activeSessionId: () => string | null;
  /** Perform the activation (top-level gate, parent bind, policy inject). */
  readonly activate: (agent: AgentLike) => ActivationOutcome;
}

/** Map an activation outcome to user-visible command copy. */
export function activationResultCopy(
  outcome: ActivationOutcome,
): CommandResultLike {
  if (outcome.ok) {
    return { kind: "success", text: DISPATCHER_START_SUCCESS };
  }
  switch (outcome.reason) {
    case "not-top-level":
      return { kind: "error", text: DISPATCHER_START_NOT_TOP_LEVEL };
    case "already-active-elsewhere":
      return { kind: "error", text: DISPATCHER_START_ALREADY_ELSEWHERE };
    case "already-active-here":
      return { kind: "success", text: DISPATCHER_START_ALREADY_HERE };
    case "unbound":
      // Unreachable through the wired plugin (the command unregisters with
      // the lifecycle); refuse rather than guess.
      return { kind: "error", text: DISPATCHER_START_UNRESOLVED };
  }
}

/** Build the `dispatcher-start` command definition. */
export function createDispatcherStartCommand(options: RegisterDispatcherStartCommandOptions): CommandDefinitionLike {
  return {
    name: DISPATCHER_START_COMMAND,
    description: DISPATCHER_START_DESCRIPTION,
    handler(invocation) {
      const agent: AgentLike | undefined = invocation?.agent;
      if (agent == null || agent.session == null) {
        // Design-16 §4.1 fallback: refuse with an error rather than guess.
        return { kind: "error", text: DISPATCHER_START_UNRESOLVED };
      }
      const sessionId = String(agent.session.id);
      const current = options.activeSessionId();
      if (current !== null && current === sessionId) {
        return { kind: "success", text: DISPATCHER_START_ALREADY_HERE };
      }
      return activationResultCopy(options.activate(agent));
    },
  };
}

/**
 * Register the activation command on ctx.commands. Returns the disposer,
 * or a no-op when the registry is unavailable (stub contexts).
 */
export function registerDispatcherStartCommand(
  options: RegisterDispatcherStartCommandOptions,
): () => void {
  const commands = options.ctx.commands;
  if (commands === undefined || typeof commands.register !== "function") {
    return () => {};
  }
  return commands.register(createDispatcherStartCommand(options));
}
