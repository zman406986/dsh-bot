/**
 * Client action wiring (ticket 40): the ONE egress from the client face to
 * the user's own send paths, bound to the seams ticket 36 verified
 * (`docs/research/dsh-capsule-seams.md`).
 *
 * The epic rule (ADR-0009, design-16 §3.4): any client affordance calls the
 * same send paths the user's own typing reaches — it must never invent a
 * second channel — so this module defines the ONLY outbound surface the
 * client may use, a narrow {@link CommandTransport}, and binds no service
 * itself: `src/client/index.ts` composes the real transport over the
 * structural faces at module-composition time, and tests inject fakes
 * (offline, S8 — the test double proves the client works without a browser
 * or host).
 *
 * The transport carries the TWO verified user-send paths, because the
 * installed host admits them differently (both facts verified against the
 * 0.1.5-rc.1 tree, see the seam note §2):
 *
 * - **command** — the composer's exact command transaction:
 *   `ctx.remote.commands.execute(sessionId, line, attachments)`. The host's
 *   command runtime parses the line, logs `command/run`/`command/done` with
 *   `source: {kind: "user"}`, and runs the same handler a typed line
 *   reaches — identical admission, no second channel. (Ticket 89 note: the
 *   capsule's start button was the transaction's only in-tree caller and
 *   retired with the capsule; the method stays as the verified seam. The
 *   retired client-side `/dsh-bot` line constant went with it —
 *   the HOST-side activation command is `src/adapter`'s, untouched.)
 * - **prompt** — a plain-language message submitted as the user's own turn
 *   through the prompt sink. The command endpoint is deliberately NOT used
 *   for conversational text: `CommandRuntime.execute` returns `undefined`
 *   when the line parses as no command, so a conversational line would
 *   silently do nothing there. The sink is the host-documented
 *   scope-addressed face: `ctx.sessions.scope(id)` resolves the session's
 *   Agent-scoped context, and the service is reached from it through the
 *   **service-method boundary** — `scoped.get("conversation")` — the host's
 *   own scoped call shape. Ticket 92 (live, 2026-09-19) proved the PROPERTY
 *   read (`scoped.conversation`) cannot work there: the cordis context proxy
 *   resolves a service property by walking the fiber chain
 *   (`cordis/lib/index.js:672-694`), and the scope fiber injects nothing, so
 *   the walk reaches the root fiber and throws `cannot get property
 *   "conversation" without inject` — the whole send died before the sink was
 *   reached. See {@link scopedConversation} for the citations. This is the
 *   path the wrapper shell's conversation composer rides (ticket 80).
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
 * Ticket 89 (2026-09-19): the capsule-era activation machinery — the start/
 * stop intents, the CAPSULE_ACTION_* + CAPSULE_STOP_MESSAGE_KEY copy keys,
 * `activationOutcomeCopyKey`, and the capsule action-notice store — is
 * DELETED with the capsule it served; the live conversation pane has its
 * own `shell.conv.*` honesty copy.
 *
 * Pure and dependency-light: no React, no DOM, no Cordis.
 */
import type {
  ClientConversationLike,
  ClientRemoteLike,
  ClientSessionsLike,
  ScopedAgentContextLike,
  ScopedConversationLike,
} from "./context.js";

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
  /** The host resolved the command but reported `ok: false` (it did not run). */
  | { readonly kind: "failed" }
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
 * Resolve the scoped conversation face from a session-scope context — the
 * ONE verified shape (ticket 92, 2026-09-19):
 *
 * ```ts
 * const scoped = sessions.scope(sessionId);       // Agent-scoped ctx (tagged)
 * const conversation = scoped.get("conversation"); // service-method boundary
 * ```
 *
 * The host's own scoped call sites do exactly this:
 * `dsh-client-ui-conversation/lib/client.js:16500-16506`
 * (`scopedConversation`: `sessions.scope(id)` → `scoped.get("conversation")`)
 * and `:14375-14377` (the queue dock). Why not the property read:
 *
 * - The cordis context proxy resolves a service PROPERTY read by walking the
 *   FIBER chain from the accessing context (`cordis/lib/index.js:672-694`).
 *   The scope fiber is the no-op `agentScope` plugin
 *   (`dsh-api-session-controller/lib/types/client/scope.js:21-36`) — it
 *   injects nothing — so the walk leaves the sessions plugin's fiber, reaches
 *   the root fiber, and `fiber.runtime === null` throws
 *   `cannot get property "conversation" without inject` (`lib/index.js:690`).
 *   The conversation service is provided by a CHILD plugin of the
 *   conversation module's fiber (`dsh-client-ui-conversation/lib/client.js
 *   :16837`), so it is never on the scope fiber's ancestor chain. The live
 *   composer send died exactly here (ticket 92: `sendPrompt`'s
 *   `actx?.conversation` threw; `src/client/index.ts`'s catch produced the
 *   honest `failed` line, no model turn).
 * - `ctx.get(name)` (cordis `reflect.get`, `lib/index.js:762-764`) resolves
 *   through the isolate-keyed service store with NO fiber walk, and still
 *   wraps the value with the ACCESSING context (`getTraceable(this.ctx, …)`,
 *   `lib/index.js:763`), so the host's `scopeOf(this.ctx)` tag check
 *   (`dsh-client-ui-conversation/lib/client.js:3170-3181`) finds the session
 *   id and the scope-addressed verbs work.
 *
 * The property read remains ONLY as a structural fallback for a runtime whose
 * context has no `get` (offline fakes, a non-cordis host); it is not a
 * verified live shape, and a throwing read degrades to `undefined` (the
 * caller's honest absence) rather than escaping as a crash.
 *
 * The returned face must be used as a METHOD receiver (`face.send(text)`,
 * `face.loadOlder()`): the host rebinds `this.ctx` to the accessing scope
 * through the service tracker, so a detached verb reference loses the tag.
 */
export function scopedConversation(
  actx: ScopedAgentContextLike | undefined,
): ScopedConversationLike | undefined {
  if (actx == null) return undefined;
  const faceOf = (value: unknown): ScopedConversationLike | undefined =>
    typeof value === "object" && value !== null
      ? (value as ScopedConversationLike)
      : undefined;
  if (typeof actx.get === "function") {
    // The verified live shape: `get` resolving nothing means the service is
    // genuinely absent here — never fall through to the property read.
    try {
      return faceOf(actx.get("conversation"));
    } catch {
      return undefined;
    }
  }
  try {
    return faceOf(actx.conversation);
  } catch {
    // A host-shaped scope whose property read throws (the live behaviour).
    return undefined;
  }
}

/**
 * Resolve one session's scoped conversation face, containing a throwing
 * `sessions.scope` (the host's context proxy can throw at the property read)
 * as the honest absence of a channel. Never throws.
 */
function scopedConversationFor(
  sessions: ClientSessionsLike,
  sessionId: string,
): ScopedConversationLike | undefined {
  try {
    return scopedConversation(sessions.scope(sessionId));
  } catch {
    return undefined;
  }
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
      if (remote === undefined) return { kind: "no-channel" };
      // The nested face read is where the inject contract bites: the resolver
      // matches inject entries by EXACT STRING (never dot-splits), so
      // `remote.commands` on a fiber declaring only `remote` THROWS
      // `cannot get property "remote.commands" without inject`. A throw at a
      // property READ is what the optional chain cannot catch, and it would
      // escape this async method as a rejected promise — so guard the probe
      // and report the honest `no-channel` (the same outcome as a
      // structurally absent face), never a silent egress death.
      try {
        if (typeof remote.commands?.execute !== "function") {
          return { kind: "no-channel" };
        }
      } catch {
        return { kind: "no-channel" };
      }
      // The composer's exact transaction: empty attachments, verbatim line.
      const result = await remote.commands.execute(sessionId, line, []);
      // The installed host resolves `{ok, value}`: `ok: false` means the
      // command did not run, and an accepted execution with an undefined
      // `value` means the line parsed to no command. The legacy bare
      // `undefined` answer is the same "nothing ran" fact.
      if (typeof result === "object" && result !== null) {
        const reply = result as { readonly ok?: unknown; readonly value?: unknown };
        if (reply.ok === false) return { kind: "failed" };
        if (reply.value === undefined) return { kind: "unresolved" };
        return { kind: "executed" };
      }
      return result === undefined
        ? { kind: "unresolved" }
        : { kind: "executed" };
    },
    async sendPrompt(sessionId, text) {
      const sessions = sources.sessions();
      if (sessions === undefined) return { kind: "no-channel" };
      const sink = scopedConversationFor(sessions, sessionId);
      if (sink === undefined || typeof sink.send !== "function") {
        return { kind: "no-channel" };
      }
      // Called AS A METHOD of the scoped face: the host's tracker rebinding
      // (and with it the session tag) rides the call receiver.
      await sink.send(text);
      return { kind: "sent" };
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
 * sessions service (scope) and the conversation input resolver, plus the
 * current session id.
 *
 * 0.2.x removed the feed's `current` selection (`SessionListState` carries no
 * such field; selection is view-owned). The caller therefore supplies the
 * session the user is looking at — the shell mount passes its own selection
 * store — instead of reading a selection the host no longer tracks.
 */
export interface SteerPrefillSources {
  sessions(): ClientSessionsLike | undefined;
  conversation(): ClientConversationLike | undefined;
  /** The selected session id (the view owner's selection), if any. */
  currentSessionId?(): string | undefined;
}

/**
 * Prefill the host composer draft with `/dispatcher-steer <workerId> ` for
 * one roster row (ticket 40), via the verified resolver path
 * `ctx.conversation.input.for(actx).setDraft(text)`. Focus is NOT part of
 * the seam (package-internal to the composer) — the caller pairs a
 * `prefilled` result with the locale hint; `unavailable` (no session, no
 * scope, no resolver, or a throwing read) degrades to the copy-only
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
  const sessionId = sources.currentSessionId?.();
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return { kind: "unavailable" };
  }
  try {
    // Inside the try: `sessions.scope` is a host service call and a
    // host-shaped scope can throw at the read. A throw is the honest
    // "prefill unreachable", never a crash out of a click handler.
    const actx = sessions.scope(sessionId);
    if (actx == null) return { kind: "unavailable" };
    conversation.input.for(actx).setDraft(steerCommandPrefill(workerId));
    return { kind: "prefilled" };
  } catch {
    return { kind: "unavailable" };
  }
}
