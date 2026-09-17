/**
 * Capsule/panel action wiring (ticket 40): the ONE egress from the client
 * face's intents to the user's own send paths, bound to the seams ticket 36
 * verified (`docs/research/dsh-capsule-seams.md`).
 *
 * The epic rule (ADR-0009, design-16 §3.4): an activation button calls the
 * same command path — it must never invent a second activation channel — and
 * the panel stays presentation-only, so this module defines the ONLY outbound
 * surface the client intents may use, a narrow {@link CommandTransport}, and
 * binds no service itself: `src/client/index.ts` composes the real transport
 * over the structural faces at module-composition time, and tests inject
 * fakes (offline, S8 — the test double proves the client works without a
 * browser or host).
 *
 * The two intents ride two DIFFERENT verified user-send paths, because the
 * installed host admits them differently (both facts verified against the
 * 0.1.5-rc.1 tree, see the seam note §2):
 *
 * - **start** — the composer's exact command transaction:
 *   `ctx.remote.commands.execute(sessionId, line, attachments)` with the
 *   line `/dispatcher-start` VERBATIM. The host's command runtime parses the
 *   line, logs `command/run`/`command/done` with `source: {kind: "user"}`,
 *   and runs the same handler a typed line reaches — identical admission,
 *   no second channel.
 * - **stop** — a conversational INTENT (ticket 31's no-stop guard: there is
 *   no off-while-running to switch off, ADR-0005/0009). The phrasing is a
 *   plain-language ask submitted as the user's own message through the
 *   prompt sink, so the dispatcher's policy (ticket 31's stop/course-change
 *   rule, design-17 §7) treats it exactly like the user typing it. The
 *   command endpoint is deliberately NOT used: `CommandRuntime.execute`
 *   returns `undefined` when the line parses as no command, so a
 *   conversational line would silently do nothing there. The sink is the
 *   host-documented scope-addressed face — a root-scope plugin addresses a
 *   session via `ctx.sessions.scope(id)` and that scope's
 *   `conversation.send(text)` (the host's own guidance:
 *   "address one via ctx.sessions.scope(id).conversation"), the same
 *   scope-addressing mechanism ticket 36 verified for the input resolver.
 *
 * **Per-row steer affordance** — prefill only, per seam 3's verdict:
 * `ctx.conversation.input.for(actx).setDraft(text)` writes
 * `/dispatcher-steer <workerId> ` into the composer draft (caret at end).
 * Focus is NOT exposed to plugins, so the affordance pairs the prefill with
 * a locale hint ("placed in the composer — review and send"); when the
 * session scope or the input resolver is unavailable, it degrades to the
 * copy-only fallback (type the command in this chat). The steer TRANSPORT is
 * unchanged and host-side (the `/dispatcher-steer` command → core last-wins
 * queue, `src/adapter/steer-command.ts`) — this module never steers; it only
 * fills the user's own draft.
 *
 * **Failure handling** (ticket 40): a failed send maps to an honest locale
 * error line rendered by the capsule; there is no optimistic success copy,
 * no retry loop, and no invented queue — the host owns the composer journal
 * (design-17 conflict 9), and the ONLY success truth is the roster feed
 * itself: activation state flips when the host publishes a snapshot, never
 * because a click was accepted.
 *
 * Pure and dependency-light: no React, no DOM, no Cordis — asserted directly
 * by `test/client-capsule-actions.test.ts`.
 */
import type { CapsuleActivationIntent } from "./capsule-store.js";
import type {
  ClientConversationLike,
  ClientRemoteLike,
  ClientSessionsLike,
} from "./context.js";

/** The activation command line, submitted verbatim (ADR-0009). */
export const DISPATCHER_START_LINE = "/dispatcher-start";

/** The steer command name used for the per-row prefill (power path). */
export const DISPATCHER_STEER_LINE = "/dispatcher-steer";

/**
 * Exactly what the per-row steer affordance writes into the composer:
 * the exact-target power path with a trailing space, ready for the user's
 * instruction (ticket 40: `/dispatcher-steer <workerId> `). The command is
 * never REQUIRED — plain language in the activated chat stays the primary
 * steer path (design-17 §4.4).
 */
export function steerCommandPrefill(workerId: string): string {
  return `${DISPATCHER_STEER_LINE} ${workerId} `;
}

/** Result of one command-path send (the host's command transaction). */
export type CommandSendResult =
  /** The host resolved and ran the command (its result copy is host-owned). */
  | { readonly kind: "executed" }
  /** The host resolved NO command (unknown name/syntax — e.g. flag off). */
  | { readonly kind: "unresolved" }
  /** No command channel is reachable (service absent in this runtime). */
  | { readonly kind: "no-channel" };

/** Result of one plain-prompt send (the user's conversational path). */
export type PromptSendResult =
  /** The sink accepted the prompt (queued turn; host owns delivery states). */
  | { readonly kind: "sent" }
  /** No prompt channel is reachable (service/scope absent in this runtime). */
  | { readonly kind: "no-channel" };

/**
 * The ONE egress from client intents to the user's own send paths. Two
 * methods because the host admits the two kinds of user input on two
 * different verified transactions (module comment); both are exactly what
 * the user's own typing triggers — nothing else may be added here.
 */
export interface CommandTransport {
  /** Execute one command line in a session, exactly as a typed line would. */
  sendCommand(sessionId: string, line: string): Promise<CommandSendResult>;
  /** Send one plain-language prompt into a session (queued user turn). */
  sendPrompt(sessionId: string, text: string): Promise<PromptSendResult>;
}

/**
 * Lazy service sources so the transport resolves the real faces at SEND
 * time, not apply time (the services materialize with the shipped
 * composition; a runtime without them reports `no-channel` honestly instead
 * of binding a dead seat once at boot).
 */
export interface TransportSources {
  remote(): ClientRemoteLike | undefined;
  sessions(): ClientSessionsLike | undefined;
}

/**
 * The real transport over the verified seams (ticket 36 §2), composed once
 * in `src/client/index.ts` and injectable for tests via fake sources.
 * Every method reports `no-channel` rather than throwing when the service
 * face is absent, so unavailability is an honest outcome, never a crash.
 */
export function bindCommandTransport(sources: TransportSources): CommandTransport {
  return {
    async sendCommand(sessionId, line) {
      const remote = sources.remote();
      if (
        remote === undefined ||
        typeof remote.commands?.execute !== "function"
      ) {
        return { kind: "no-channel" };
      }
      // The composer's exact transaction: empty attachments, verbatim line.
      const result = await remote.commands.execute(sessionId, line, []);
      // The host returns `undefined` when the line parses to no command —
      // honest "nothing ran", not a transport failure.
      return result === undefined
        ? { kind: "unresolved" }
        : { kind: "executed" };
    },
    async sendPrompt(sessionId, text) {
      const sessions = sources.sessions();
      if (sessions === undefined) return { kind: "no-channel" };
      const actx = sessions.scope(sessionId);
      const sink = actx?.conversation;
      if (actx == null || typeof sink?.send !== "function") {
        return { kind: "no-channel" };
      }
      await sink.send(text);
      return { kind: "sent" };
    },
  };
}

/** How an intent's send settled. Deliberately NO "success" kind: the only
 * activation success truth is the roster feed, never a click's receipt. */
export type ActivationSendOutcome =
  /** The transport accepted the line/prompt (no activation claim attached). */
  | { readonly kind: "sent" }
  /** The transport rejected the send — nothing was changed. */
  | { readonly kind: "failed" }
  /** The host resolved no command (e.g. the flag is off here). */
  | { readonly kind: "unresolved" }
  /** No channel or no current session — nothing was addressable. */
  | { readonly kind: "unavailable" };

/** Locale key for the failed-send error line. */
export const CAPSULE_ACTION_SEND_FAILED_KEY = "capsule.action.send-failed";

/** Locale key for the "command not available here" line. */
export const CAPSULE_ACTION_NOT_AVAILABLE_KEY = "capsule.action.not-available";

/** Locale key for the "no command channel" degraded line. */
export const CAPSULE_ACTION_NO_CHANNEL_KEY = "capsule.action.no-channel";

/** Locale key whose value is the SUBMITTED conversational stop phrasing. */
export const CAPSULE_STOP_MESSAGE_KEY = "capsule.stop.message";

/**
 * Map a send outcome to its honest capsule notice copy key, or `null` for
 * silence. `sent` maps to NULL on purpose: no optimistic fake success — the
 * roster feed shows the real state when (and only when) the host publishes
 * it, and the stop ask is confirmed conversationally by the dispatcher.
 */
export function activationOutcomeCopyKey(
  outcome: ActivationSendOutcome,
): string | null {
  switch (outcome.kind) {
    case "sent":
      return null;
    case "failed":
      return CAPSULE_ACTION_SEND_FAILED_KEY;
    case "unresolved":
      return CAPSULE_ACTION_NOT_AVAILABLE_KEY;
    case "unavailable":
      return CAPSULE_ACTION_NO_CHANNEL_KEY;
  }
}

/**
 * Submit one activation intent through the transport (ticket 40). The stop
 * intent's phrasing must come pre-resolved from the locale seat (the caller
 * passes `t(CAPSULE_STOP_MESSAGE_KEY)`), so tests can assert the submitted
 * text via the locale key rather than literals.
 *
 * Resolves the current session at CALL time (fresh — the user may have
 * switched chats since the capsule rendered); with no addressable session
 * the outcome is `unavailable` and the transport is never touched.
 */
export async function sendActivationIntent(
  transport: CommandTransport,
  currentSessionId: () => string | undefined,
  intent: CapsuleActivationIntent,
  stopMessage: string,
): Promise<ActivationSendOutcome> {
  const sessionId = currentSessionId();
  if (sessionId === undefined) return { kind: "unavailable" };
  try {
    if (intent === "start") {
      const result = await transport.sendCommand(sessionId, DISPATCHER_START_LINE);
      if (result.kind === "no-channel") return { kind: "unavailable" };
      return result.kind === "unresolved"
        ? { kind: "unresolved" }
        : { kind: "sent" };
    }
    const result = await transport.sendPrompt(sessionId, stopMessage);
    return result.kind === "no-channel" ? { kind: "unavailable" } : { kind: "sent" };
  } catch {
    // Transport rejection: honest failure copy, no retry, no invented queue.
    return { kind: "failed" };
  }
}

/**
 * The capsule's action-notice line: the honest error copy from the last
 * attempt, cleared when the next attempt starts. Box identity changes only
 * on a real transition (same discipline as `CapsuleStore`), and the box
 * carries ONLY a copy key — there is no success state to flip to.
 */
export interface CapsuleActionStatusBox {
  readonly copyKey: string | null;
  readonly version: number;
}

export interface CapsuleActionStatus {
  /** Stable getter for `useSyncExternalStore`. */
  getBox(): CapsuleActionStatusBox;
  /** Replace the notice (`null` clears); no-op when unchanged. */
  set(copyKey: string | null): void;
  /** Subscribe; returns the unsubscribe disposer. */
  subscribe(listener: () => void): () => void;
}

export function createCapsuleActionStatus(): CapsuleActionStatus {
  let copyKey: string | null = null;
  let version = 0;
  let box: CapsuleActionStatusBox = { copyKey, version };
  const listeners = new Set<() => void>();

  return {
    getBox() {
      return box;
    },
    set(next: string | null) {
      if (next === copyKey) return;
      copyKey = next;
      version += 1;
      box = { copyKey, version };
      for (const listener of [...listeners]) {
        listener();
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Per-row steer outcome: the draft was written, or prefill was impossible. */
export type SteerPrefillOutcome =
  | { readonly kind: "prefilled" }
  | { readonly kind: "unavailable" };

/** Locale key for the per-row steer affordance button. */
export const ROSTER_STEER_BUTTON_KEY = "roster.steer.button";

/** Locale key for the post-prefill hint ({workerId} substituted). */
export const ROSTER_STEER_HINT_KEY = "roster.steer.hint";

/** Locale key for the copy-only fallback when prefill is impossible. */
export const ROSTER_STEER_COPY_FALLBACK_KEY = "roster.steer.copy-fallback";

/**
 * Lazy sources for the steer prefill's verified seam (ticket 36 §3): the
 * sessions service (current selection + scope) and the conversation input
 * resolver. Getters, so the faces resolve at click time.
 */
export interface SteerPrefillSources {
  sessions(): ClientSessionsLike | undefined;
  conversation(): ClientConversationLike | undefined;
}

/**
 * Prefill the host composer draft with `/dispatcher-steer <workerId> ` for
 * one roster row (ticket 40), via the verified resolver path
 * `ctx.conversation.input.for(actx).setDraft(text)`. Focus is NOT part of
 * the seam (package-internal to the composer) — the caller pairs a
 * `prefilled` result with the locale hint; `unavailable` (no session, no
 * scope, no resolver, or a throwing write) degrades to the copy-only
 * fallback. Never touches the host-side steer transport.
 */
export function tryPrefillSteer(
  sources: SteerPrefillSources,
  workerId: string,
): SteerPrefillOutcome {
  const sessions = sources.sessions();
  const conversation = sources.conversation();
  if (sessions === undefined || conversation === undefined) {
    return { kind: "unavailable" };
  }
  const sessionId = sessions.list.getSnapshot().current;
  if (sessionId === undefined) return { kind: "unavailable" };
  const actx = sessions.scope(sessionId);
  if (actx == null) return { kind: "unavailable" };
  try {
    conversation.input.for(actx).setDraft(steerCommandPrefill(workerId));
    return { kind: "prefilled" };
  } catch {
    return { kind: "unavailable" };
  }
}
