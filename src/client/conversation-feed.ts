/**
 * Conversation feed binding (ticket 80, ADR-0020 slice 4): keeps the
 * conversation store's transcript for the SELECTED session fed from that
 * session's verified event window — `sessions.binding(id).eventSource`
 * (Finding 7, `wrapper-vehicle-seams.md`; the store in
 * `conversation-store.ts` reduces it).
 *
 * The driver is the SHELL selection (ticket 79's store), because the window
 * opens when the session is STAGED — and the shell's selection already rides
 * the host's `sessions.open(id)` (the feed binding's `onOpen` hook). When the
 * selection moves, this binding unsubscribes the previous session's window
 * and resolves the new one: apply now, then live on every window
 * publication. No face, or no binding for the id, degrades to the store's
 * honest `unavailable` — never an empty transcript and never a poll loop
 * (the window is push-updated; there is no retry model, ADR-0018 U-A).
 *
 * Also here: the scoped `loadOlder()` request (Finding 7: the pagination
 * verb — `IConversation.loadOlder` scope-addressed through
 * `sessions.scope(id)`; failures land in the host's snapshot state, the
 * window is the only truth this surface reads). The verb is resolved and
 * called through `actions.ts`'s `scopedConversation` helper — ticket 92
 * (live, 2026-09-19): a service PROPERTY read on a session-scope context
 * throws on the live host (`cannot get property "conversation" without
 * inject`), and a DETACHED verb reference loses the service tracker's
 * `this.ctx` rebinding, so both the resolution and the call must go through
 * the scoped face.
 *
 * Structural shapes only (no import from `@deepseek-ai/*`); offline tests
 * drive it over fakes (S8), same discipline as `shell-feed.ts`.
 */
import type { ClientSessionsLike } from "./context.js";
import { scopedConversation } from "./actions.js";
import type { ShellSelection } from "./shell-store.js";
import {
  type ConversationSourceLike,
  type ConversationStore,
} from "./conversation-store.js";

/**
 * The shell-store face this binding reads: the selection (structural — the
 * real store satisfies it) plus the subscription seat.
 */
export interface ShellSelectionSource {
  subscribe(listener: () => void): () => void;
  getBox(): { state: { readonly selection: ShellSelection } };
}

/** The one session binding field this binding reads (structural minimal). */
export interface ClientSessionBindingLike {
  /** The session's contiguous event window ("Conversation assembly" feed). */
  readonly eventSource?: ConversationSourceLike;
}

/** What `bindConversationFeed` returns. */
export interface ConversationFeedBinding {
  /** Stop watching the shell selection and unsubscribe any window. */
  dispose(): void;
}

/**
 * Keep the selected session's transcript fed from its event window. The
 * shell store is read, never written; only actual selection CHANGES move the
 * subscription (rows/presence updates re-emit the shell store constantly and
 * must not re-resolve the binding).
 */
export function bindConversationFeed(
  conversation: ConversationStore,
  sessions: ClientSessionsLike,
  shell: ShellSelectionSource,
): ConversationFeedBinding {
  let current: string | null = null;
  let unsubscribeWindow: (() => void) | undefined;

  const detach = (): void => {
    if (unsubscribeWindow !== undefined) {
      unsubscribeWindow();
      unsubscribeWindow = undefined;
    }
  };

  const follow = (): void => {
    const selection = shell.getBox().state.selection;
    const selected =
      selection.kind === "session" ? selection.sessionId : null;
    if (selected === current) return;
    detach();
    current = selected;
    if (selected === null) return;
    const source = sessions.binding?.(selected)?.eventSource;
    if (source === undefined || typeof source.getSnapshot !== "function") {
      conversation.markUnavailable(selected);
      return;
    }
    const sync = () => conversation.applyWindow(selected, source.getSnapshot());
    sync();
    unsubscribeWindow =
      typeof source.subscribe === "function"
        ? source.subscribe(sync)
        : undefined; // snapshot-only face: apply once, degrade honestly
  };

  const disposeShell = shell.subscribe(follow);
  follow();

  return {
    dispose() {
      detach();
      current = null;
      disposeShell();
    },
  };
}

/**
 * Request one older history page for a session through the verified scoped
 * verb (`sessions.scope(id)` → `scoped.get("conversation").loadOlder()`,
 * Finding 7; ticket 92 corrected the access shape). The window is the only
 * truth: the pane renders no outcome copy for this request (silence until
 * the window changes — no optimistic "loaded" claim, no retry control);
 * `hasMore` keeps the affordance while the host says more remains. Errors
 * are contained (the verb's own failures land in the host's snapshot state)
 * — this helper never throws.
 */
export function requestOlder(
  sessions: ClientSessionsLike | undefined,
  sessionId: string,
): void {
  try {
    const face = scopedConversation(sessions?.scope(sessionId));
    if (face === undefined || typeof face.loadOlder !== "function") return;
    // Method receiver, not a detached reference: the host's session tag
    // rides the call receiver (ticket 92).
    void face.loadOlder().catch(() => {});
  } catch {
    // contained: honest absence of change, never a crash
  }
}
