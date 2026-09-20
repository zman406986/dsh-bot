/**
 * Host slash-command registration for dispatcher session DEACTIVATION
 * (ticket 101, ADR-0021 decision 3 — "dispatcher sessions can be added and
 * deleted from our UI", the conservative ruling: delete = deactivate the
 * dispatcher binding in that session; the dsh chat itself is never disposed
 * from our code — chat disposal stays a dsh-native action). The floating
 * window's per-row delete affordance executes this command through the
 * composer's own command transaction (`ctx.remote.commands.execute` — ticket
 * 36 seam 2), exactly as the approval cards execute `/dispatcher-resolve`.
 *
 * The handler runs the SAME deactivation the host `agent/disposed` listener
 * runs — `lifecycle.deactivate(sessionId)` is the internal `deactivateSession`
 * sequence (registry drop, `host.unbindParent`, `onDeactivated`: that
 * session's tool surface unregistered, its access-policy rows cleared, its
 * prompts abandoned, its roster mirror cleared — ADR-0019 per-session keying,
 * a sibling dispatcher untouched). No second deactivation path exists; a
 * command-path deactivation is indistinguishable from a dispose downstream.
 *
 * Scope note (the pin this command was ruled under): design-17 §4.6 /
 * `docs/surfaces.md`'s "no stop control" and the structural guard in
 * `test/restart-honesty.test.ts` concern stopping WORKER TURNS / the worker
 * runtime — that exclusion stands (ADR-0021 amends exception U-G for
 * dispatcher sessions ONLY). This command stops a session BINDING, never a
 * worker turn; `stop_worker` remains agent-facing only and no worker/turn
 * stop affordance is added anywhere.
 *
 * All copy is original clean-room text (design-16 §6 discipline).
 * Structural only — no import of `@deepseek-ai/dsh-commands` (peer surface).
 */

import type {
  AdapterContext,
  AgentLike,
  CommandDefinitionLike,
  CommandResultLike,
} from "./cordis-dsh-host.js";

/** Globally unique host command name (`dispatcher-` prefix, design-16 §5). */
export const DISPATCHER_STOP_COMMAND = "dispatcher-stop";

/** Command menu description. */
export const DISPATCHER_STOP_DESCRIPTION =
  "Deactivate the dispatcher in this chat (the chat itself stays).";

/**
 * Success copy: states what deactivation means (binding off, chat untouched)
 * and that it is reversible (ADR-0021 decision 3's own terms).
 */
export const DISPATCHER_STOP_SUCCESS =
  "Dispatcher deactivated in this chat: its dispatcher tools are unbound " +
  "and it no longer dispatches work. The chat itself is untouched — run " +
  "/dispatcher-start here to activate it again.";

/**
 * The invoking chat is not an activated dispatcher session. Honest no-op:
 * nothing was changed, and the copy never reads as success (the resolve
 * command's NOT_DISPATCHER refusal pattern).
 */
export const DISPATCHER_STOP_NOT_DISPATCHER =
  "This chat is not an activated dispatcher session — nothing to " +
  "deactivate. Run /dispatcher-start in a chat first to activate one.";

/** The invocation carried no resolvable live agent (refuse, never guess). */
export const DISPATCHER_STOP_UNRESOLVED =
  "Could not resolve the current chat for deactivation. Re-run this " +
  "command from the chat whose dispatcher you want to remove.";

export interface RegisterDispatcherStopCommandOptions {
  readonly ctx: AdapterContext;
  /**
   * Every activated dispatcher session id (ADR-0019: there may be several —
   * the handler gates on the INVOKING chat's own activation). Empty while
   * dormant, and empty again once the lifecycle is unbound (unload/HMR).
   */
  readonly activeSessionIds: () => readonly string[];
  /**
   * Deactivate one session — the lifecycle's `deactivate` (the dispose
   * path). Called only after the gate confirms the invoking chat IS an
   * activated dispatcher session.
   */
  readonly deactivate: (sessionId: string) => void;
}

/**
 * Build the `dispatcher-stop` command definition. The handler gates on the
 * invoking chat's own dispatcher activation (per session, ADR-0019), then
 * deactivates through the caller-supplied dispose path. Idempotent-honest:
 * a second stop (or a stop in a never-activated chat) refuses with the
 * honest no-op copy — never a fake success.
 */
export function createDispatcherStopCommand(
  options: RegisterDispatcherStopCommandOptions,
): CommandDefinitionLike {
  return {
    name: DISPATCHER_STOP_COMMAND,
    description: DISPATCHER_STOP_DESCRIPTION,
    handler(invocation) {
      const agent: AgentLike | undefined = invocation?.agent;
      if (agent == null || agent.session == null) {
        // Design-16 §4.1 fallback: refuse with an error rather than guess.
        return { kind: "error", text: DISPATCHER_STOP_UNRESOLVED };
      }
      const sessionId = String(agent.session.id);
      if (!options.activeSessionIds().includes(sessionId)) {
        return { kind: "error", text: DISPATCHER_STOP_NOT_DISPATCHER };
      }
      options.deactivate(sessionId);
      return { kind: "success", text: DISPATCHER_STOP_SUCCESS };
    },
  };
}

/**
 * Register the stop command on ctx.commands. Returns the disposer,
 * or a no-op when the registry is unavailable (stub contexts).
 */
export function registerDispatcherStopCommand(
  options: RegisterDispatcherStopCommandOptions,
): () => void {
  const commands = options.ctx.commands;
  if (commands === undefined || typeof commands.register !== "function") {
    return () => {};
  }
  return commands.register(createDispatcherStopCommand(options));
}
