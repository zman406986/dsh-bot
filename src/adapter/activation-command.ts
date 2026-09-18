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

/**
 * Presence hint appended to the activation success copy (ticket 32,
 * design-17 §7 `activation.presence-hint`). It tells the user where presence
 * lives — the app-wide Workers panel — and sets the delivery expectation:
 * results arrive as ordinary chat turns, never as a notification (no push
 * seam exists; design-17 §4.8). Appended exactly once
 * ({@link DISPATCHER_START_SUCCESS}); the client locale dictionary carries
 * the same string as `activation.presence-hint` (en) plus the zh face, and
 * `test/composition-polish.test.ts` asserts the two stay in lockstep.
 */
export const ACTIVATION_PRESENCE_HINT =
  "The Workers panel shows live progress; results arrive in this chat as " +
  "they finish.";

/** Success copy shown in the activated chat. */
export const DISPATCHER_START_SUCCESS =
  "Dispatcher active in this chat. Workers spawned here report back here; " +
  "use /dispatcher-steer to nudge a running worker. " +
  ACTIVATION_PRESENCE_HINT;

/** Same chat is already the dispatcher. */
export const DISPATCHER_START_ALREADY_HERE =
  "The dispatcher is already active in this chat.";

/**
 * Retired with the single-activation slot (ADR-0019): multiple dispatchers
 * are real — each chat activates its own dispatcher session, so there is no
 * "active elsewhere" refusal to word.
 */

/** Invoked in a child/delegated chat. */
export const DISPATCHER_START_NOT_TOP_LEVEL =
  "The dispatcher can only be activated in a top-level chat.";

/** The invocation carried no resolvable live agent (refuse, never guess). */
export const DISPATCHER_START_UNRESOLVED =
  "Could not resolve the current chat for activation. Re-run this command " +
  "from the chat you want to use as the dispatcher.";

/**
 * Retired with the execute-time gate (ADR-0019): the five dispatcher tools
 * register through the activated agent's own scoped context, so an
 * out-of-scope caller cannot see them at all — the host's `UNKNOWN_TOOL` is
 * the strictly stronger behavior and no refusal copy is needed.
 */

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
