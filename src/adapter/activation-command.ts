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
import { userTurnMessage } from "./wake-copy.js";

/**
 * Globally unique host command name. The constant NAME is retained public
 * barrel API; the VALUE is `dsh-bot` by the human's 2026-10-21 ruling
 * (ADR-0030), so the historical `dispatcher-` prefix convention
 * (design-16 §5) is intentionally broken here — the human's chosen name
 * governs.
 */
export const DISPATCHER_START_COMMAND = "dsh-bot";

/** Legacy persisted-log name of this command before the ADR-0030 rename. */
export const LEGACY_DISPATCHER_START_COMMAND = "dispatcher-start";

/** Command menu description. */
export const DISPATCHER_START_DESCRIPTION =
  "Turn this chat into the multitask dispatcher for this session.";

/**
 * Composer hint for the optional message argument.
 *
 * The host shows this hint after the claimed `/dsh-bot` token
 * (`dsh-client-ui-commands/lib/client.js:1650-1653`, installed package). A
 * claimed host command remains args-tolerant: bare Enter submits with an
 * empty argument, so advertising the input does NOT force the user to type a
 * message (`:1601-1615` returns the claim, `dsh-client-ui-conversation`
 * `:5368-5379` submits it with `argsAfter(...) === ""`). The no-argument
 * activation path therefore stays one step.
 */
export const DISPATCHER_START_INPUT_HINT =
  "Optional first message; leave blank to only activate.";

/**
 * Presence hint appended to the activation success copy (ticket 32,
 * design-17 §7 `activation.presence-hint`; panel claim removed by ticket
 * 134). It tells the user where progress lives — the dispatcher's own
 * narration in this chat, the only live route in the native-dsh posture
 * (ADR-0024; `docs/surfaces.md:29-31`) — and sets the delivery expectation:
 * results arrive as ordinary chat turns, never as a notification (no push
 * seam exists; design-17 §4.8). Appended exactly once
 * ({@link DISPATCHER_START_SUCCESS}); the client locale dictionary carries
 * the same string as `activation.presence-hint` (en) plus the zh face, and
 * `test/composition-polish.test.ts` asserts the two stay in lockstep.
 */
export const ACTIVATION_PRESENCE_HINT =
  "The dispatcher reports progress as it works; results arrive in this chat " +
  "as they finish.";

/** Success copy shown in the activated chat. */
export const DISPATCHER_START_SUCCESS =
  "Dispatcher active in this chat. Workers spawned here report back here; " +
  "use /dispatcher-steer to nudge a running worker. " +
  ACTIVATION_PRESENCE_HINT;

/**
 * Ticket 295: the one-line account of the visible activation notice — the
 * deferred notice's collapsed chat row summary, above its full
 * {@link DISPATCHER_START_SUCCESS} body. This is NOT the immediate command
 * card's text (see {@link ACTIVATION_COMMAND_CARD_TEXT}). Server-side and
 * therefore outside the client locale dictionary, so it is English only.
 */
export const ACTIVATION_NOTICE_SUMMARY = "Dispatcher active in this chat.";

/**
 * The `/dsh-bot` command card's result line — the only confirmation the user
 * sees at the instant the command returns, because the full notice is deferred
 * to the first turn (ticket 298). The chat renders a command result as one
 * collapsed row (`white-space: nowrap` + ellipsis) and builds a body only
 * when the text contains a newline (`dsh-client-ui-chat/lib/client.js:8489`,
 * `:8499-8501`), so this line must be self-contained and short enough to read
 * in full: dispatcher active, results arrive in this chat, and
 * `/dispatcher-steer` nudges a running worker.
 *
 * Measured against the shipped row at 13px: 67 characters render 372px wide,
 * with no clipping down to a 480px chat column; the content column itself is
 * `clamp(680px, 64% of the conversation column, 920px)`. Deliberately separate
 * from {@link DISPATCHER_START_SUCCESS}, whose 208-character paragraph stays
 * the deferred notice body.
 */
export const ACTIVATION_COMMAND_CARD_TEXT =
  "Dispatcher active. Results arrive here; /dispatcher-steer to nudge.";

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
 * Retired with the execute-time gate (ADR-0019): the six dispatcher tools
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

/**
 * The message argument, normalized: the host's `rawInput` includes the
 * separator whitespace after the command name (`dsh-commands/lib/types`),
 * and a whitespace-only line must count as no message so plain `/dsh-bot`
 * keeps its turn-free behavior.
 */
function dispatcherStartMessage(rawInput: string | undefined): string {
  return rawInput === undefined ? "" : rawInput.trim();
}

/** Map an activation outcome to user-visible command copy. */
export function activationResultCopy(
  outcome: ActivationOutcome,
): CommandResultLike {
  if (outcome.ok) {
    // The immediate card is one readable line; DISPATCHER_START_SUCCESS stays
    // the deferred notice body (tickets 295/298).
    return { kind: "success", text: ACTIVATION_COMMAND_CARD_TEXT };
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

/** Build the `dsh-bot` command definition (name: {@link DISPATCHER_START_COMMAND}). */
export function createDispatcherStartCommand(options: RegisterDispatcherStartCommandOptions): CommandDefinitionLike {
  return {
    name: DISPATCHER_START_COMMAND,
    description: DISPATCHER_START_DESCRIPTION,
    // The claim is args-tolerant (see DISPATCHER_START_INPUT_HINT): bare
    // Enter still activates immediately with no turn; a non-empty argument
    // opens the first turn below.
    input: { hint: DISPATCHER_START_INPUT_HINT },
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
      const outcome = options.activate(agent);
      // Never on failure, never when the activation was already live. The
      // message opens the first turn only after activation stands, so a
      // refused command leaves the chat exactly as turn-free as before.
      const message = dispatcherStartMessage(invocation.rawInput);
      if (outcome.ok && message.length > 0) {
        try {
          // `followup` is the host's "next-turn" send with a wake
          // (`dsh-agent-loop/lib/index.js:570-572`): the message enters the
          // session as one user turn and starts it. `userTurnMessage` stamps
          // `source.kind: "user"`, which is what the chat renders as the
          // user's own message and what opens the deferred restart-notice
          // gate. Best-effort: activation already stands if this fails.
          void Promise.resolve(agent.followup(userTurnMessage(message))).catch(
            () => {
              // Opening the first turn never rewrites the command result.
            },
          );
        } catch {
          // Same: a broken followup must not turn a successful activation
          // into a command failure.
        }
      }
      return activationResultCopy(outcome);
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
