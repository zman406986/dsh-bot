/**
 * Host slash-command registration for access-ask answers (ticket 69, L1
 * offline half). The resolve TRANSPORT: the wrapper's approval-card button
 * executes this command through the composer's own transaction
 * (`ctx.remote.commands.execute` — ticket 36 seam 2, the same verified
 * surface ticket 40's start transport uses), and the handler routes the
 * answer into the UNCHANGED core relay via `Multitask.resolveAccess` —
 * exactly the entry point the ticket-23 access prompt pump uses
 * (`src/plugin.ts`). The command is an input path, not new relay semantics:
 * no timeout, dedupe, or delivery behavior lives here (ADR-0008 untouched).
 *
 * Registered at apply (flag ON) with an in-handler activation gate, per the
 * dispatcher-steer lifecycle pattern (ticket 22): the dormant plugin shows
 * the command, but the handler refuses anything that is not the activated
 * dispatcher chat. "Always allow (this session)" inserts the SAME
 * session-scope allow row the prompt pump's `alwaysAllow` sink inserts —
 * class + exact target, attributed to the ticket's own session (ADR-0019);
 * the wildcard fence is re-applied here (defense in depth — an
 * always-shaped answer for a `*`-bearing target degrades to a plain
 * one-shot allow, ticket 30's rule).
 *
 * All copy is original clean-room text (design-16 §6).
 * Structural only — no import of `@deepseek-ai/dsh-commands` (peer surface).
 */

import type { AccessDecision, AccessTicket } from "../core/access-types.js";
import type {
  AdapterContext,
  AgentLike,
  CommandDefinitionLike,
  CommandResultLike,
} from "./cordis-dsh-host.js";

/** Globally unique host command name (`dispatcher-` prefix, design-16 §5). */
export const DISPATCHER_RESOLVE_COMMAND = "dispatcher-resolve";

/** Command menu description. */
export const DISPATCHER_RESOLVE_DESCRIPTION =
  "Answer a worker's pending access ask. Allow once, always allow for " +
  "this session, or deny.";

/** Input hint advertised with the command (design-16 §6). */
export const DISPATCHER_RESOLVE_INPUT_HINT =
  "worker id, then allow | always-allow | deny";

/** Success copy (design-16 §6 template, worker id substituted). */
export function dispatcherResolveSuccess(workerId: string): string {
  return `Answer routed for ${workerId}.`;
}

/** No dispatcher is active — nothing to answer through. */
export const DISPATCHER_RESOLVE_NOT_ACTIVE =
  "No dispatcher is active yet. Run /dispatcher-start in a top-level chat " +
  "first.";

/**
 * A dispatcher is active, but not in the chat that invoked the command.
 * A non-top-level chat can never hold the activation (activation refuses
 * it), so this refusal covers child/delegated chats too.
 */
export const DISPATCHER_RESOLVE_NOT_DISPATCHER =
  "Access answers run in the dispatcher chat. Send /dispatcher-resolve " +
  "from the chat where you ran /dispatcher-start.";

/** Missing or malformed input. */
export const DISPATCHER_RESOLVE_USAGE =
  "Provide a worker id and a choice. Example: /dispatcher-resolve " +
  "worker-1 allow (choices: allow | always-allow | deny).";

/** No pending ask for that worker in this chat. */
export function dispatcherResolveNoPendingAsk(workerId: string): string {
  return `No pending access ask for ${workerId} in this chat.`;
}

/**
 * The relay refused (already resolved / worker gone — e.g. the ADR-0008
 * timeout deny landed first). Nothing was changed; the honest answer is
 * "too late", never a fake success.
 */
export function dispatcherResolveSettled(workerId: string): string {
  return `${workerId}'s ask is no longer waiting (it may have timed out and ` +
    "been denied by default).";
}

/** Deny detail recorded on a command-path denial (names the input path). */
export const DISPATCHER_RESOLVE_DENY_DETAIL =
  "denied from the dispatcher chat";

/** The three choices a resolve answer can carry (the card option kinds). */
export type DispatcherResolveChoice = "allow" | "always-allow" | "deny";

/** Parsed resolve payload: worker id + choice token. */
export interface ParsedResolveInput {
  readonly workerId: string;
  readonly choice: DispatcherResolveChoice;
}

/**
 * Parse "<worker id> <allow|always-allow|deny>" raw command input. Returns
 * null when either part is missing or the choice is not in the vocabulary —
 * the caller refuses with usage copy.
 */
export function parseResolveInput(
  rawInput: string | undefined,
): ParsedResolveInput | null {
  const text = (rawInput ?? "").trim();
  const match = /^(\S+)\s+(allow|always-allow|deny)$/.exec(text);
  if (match === null) return null;
  const workerId = match[1];
  const choice = match[2] as DispatcherResolveChoice;
  if (workerId === undefined || workerId.length === 0) return null;
  return { workerId, choice };
}

export interface RegisterDispatcherResolveCommandOptions {
  readonly ctx: AdapterContext;
  /**
   * Every activated dispatcher session id (ADR-0019: there may be several —
   * the handler gates on the INVOKING chat's own activation, not a single
   * slot). Empty while dormant.
   */
  readonly activeSessionIds: () => readonly string[];
  /**
   * The pending ask of one worker scoped to the invoking session, or
   * undefined. Scoped — a sibling dispatcher's ask is invisible here, the
   * same per-session fence the prompt pump's `listPending` uses.
   */
  readonly findPending: (
    workerId: string,
    parentSessionId: string,
  ) => AccessTicket | undefined;
  /** Route the decision into the relay (`Multitask.resolveAccess`). */
  readonly resolve: (workerId: string, decision: AccessDecision) => boolean;
  /**
   * Insert the session-scope allow row for an always-allow answer. The
   * caller owns the ADR-0019 attribution and the wildcard fence (the
   * command path re-checks below, but the sink is authoritative).
   */
  readonly alwaysAllow: (ticket: AccessTicket) => void;
  /** Wildcard fence predicate (the adapter's shipped one). */
  readonly isWildcardTarget: (target: string) => boolean;
}

/**
 * Build the `dispatcher-resolve` command definition. The handler gates on
 * the invoking chat's own dispatcher activation (per session, ADR-0019),
 * parses the payload, scopes the ask to the invoking session, and routes
 * the decision through the same core entry point the access prompt uses —
 * it never re-implements relay semantics.
 */
export function createDispatcherResolveCommand(
  options: RegisterDispatcherResolveCommandOptions,
): CommandDefinitionLike {
  return {
    name: DISPATCHER_RESOLVE_COMMAND,
    description: DISPATCHER_RESOLVE_DESCRIPTION,
    input: { hint: DISPATCHER_RESOLVE_INPUT_HINT },
    handler(invocation) {
      const agent: AgentLike | undefined = invocation?.agent;
      const active = options.activeSessionIds();
      const sessionId =
        agent?.session == null ? undefined : String(agent.session.id);
      if (active.length === 0 || sessionId === undefined) {
        return { kind: "error", text: DISPATCHER_RESOLVE_NOT_ACTIVE };
      }
      if (!active.includes(sessionId)) {
        return { kind: "error", text: DISPATCHER_RESOLVE_NOT_DISPATCHER };
      }
      const parsed = parseResolveInput(invocation.rawInput);
      if (parsed === null) {
        return { kind: "error", text: DISPATCHER_RESOLVE_USAGE };
      }
      const ticket = options.findPending(parsed.workerId, sessionId);
      if (ticket === undefined) {
        return {
          kind: "error",
          text: dispatcherResolveNoPendingAsk(parsed.workerId),
        };
      }
      // Ticket 30's wildcard fence, command path: an always-shaped answer
      // for a `*`-bearing target degrades to a plain one-shot allow —
      // consent covers the exact target shown, never a pattern.
      if (parsed.choice === "always-allow") {
        if (!options.isWildcardTarget(ticket.body.target)) {
          options.alwaysAllow(ticket);
        }
      }
      const decision: AccessDecision =
        parsed.choice === "deny"
          ? {
              kind: "deny",
              reason: "user-denied",
              detail: DISPATCHER_RESOLVE_DENY_DETAIL,
            }
          : { kind: "allow" };
      const routed = options.resolve(parsed.workerId, decision);
      return routed
        ? { kind: "success", text: dispatcherResolveSuccess(parsed.workerId) }
        : {
            kind: "error",
            text: dispatcherResolveSettled(parsed.workerId),
          };
    },
  };
}

/**
 * Register the resolve command on ctx.commands. Returns the disposer, or a
 * no-op when the registry is unavailable (stub contexts).
 */
export function registerDispatcherResolveCommand(
  options: RegisterDispatcherResolveCommandOptions,
): () => void {
  const commands = options.ctx.commands;
  if (commands === undefined || typeof commands.register !== "function") {
    return () => {};
  }
  return commands.register(createDispatcherResolveCommand(options));
}
