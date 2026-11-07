/**
 * Conversation feed binding (ticket 80, ADR-0020 slice 4): keeps the
 * conversation store's transcript for the SELECTED session fed from that
 * session's verified event window — the assembly feed exposed by the
 * session's retained reference (`sessions.retain(id).binding.eventSource`,
 * awaited through `reference.ready`; 0.2.x replaced the retired
 * `sessions.open(id)` selection verb with retain + reference + binding —
 * `ISessions`, dsh-api-session-controller `client/contract/sessions.d.ts`).
 * The store in `conversation-store.ts` reduces it.
 *
 * The driver is the SHELL selection (ticket 79's store), which is view-owned
 * in 0.2.x: selecting a row in our sidebar store is what makes this binding
 * acquire (retain) the session, so the pane opens without any host selection
 * verb. When the selection moves, this binding releases the previous
 * reference and resolves the new one: apply now, then live on every window
 * publication. No face, no retain path, a throwing retain, or no binding for
 * the id degrades to the store's honest `unavailable` — never an empty
 * transcript and never a poll loop (the window is push-updated; there is no
 * retry model, ADR-0018 U-A).
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
import type {
  ClientSessionBindingLike,
  ClientSessionReferenceLike,
  ClientSessionsLike,
} from "./context.js";
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

/** What `bindConversationFeed` returns. */
export interface ConversationFeedBinding {
  /** Stop watching the shell selection, release the reference, unsubscribe. */
  dispose(): void;
}

/**
 * The consumer label this feed retains under (`SessionRetainOptions.source`,
 * dsh-api-session-controller `client/contract/sessions.d.ts:31-34`). The host
 * keys its reference counts by source; ours is stable and ours alone.
 */
export const CONVERSATION_FEED_SOURCE = "multitask-dispatcher-shell";

/**
 * Keep the selected session's transcript fed from its event window. The
 * shell store is read, never written; only actual selection CHANGES move the
 * subscription (rows/presence updates re-emit the shell store constantly and
 * must not re-resolve the binding).
 *
 * The installed 0.2.x shape is RETAIN + REFERENCE + BINDING: `sessions.retain`
 * acquires a reference and starts the shared initial history opening, the
 * reference's `binding.eventSource` is the assembly feed, and `ready` settles
 * the open. A bare `binding(id)` borrow is the read-only fallback for a
 * runtime that serves one. Both replace the retired `sessions.open(id)`
 * selection verb; keeping the old verb would leave the pane permanently
 * unavailable. The reference is held while the session is selected (a send
 * needs a retained scope) and released on deselect/dispose.
 */
/**
 * A retained reference opens with a provisional empty window at revision 0
 * (`entries: []`, `revision: 0`) before `ready` settles the shared initial
 * open. That is "not open yet", never an empty transcript: rendering it as
 * `ready` with zero turns claims the session has no history.
 */
export function isEmptyInitialWindow(window: unknown): boolean {
  if (typeof window !== "object" || window === null) return false;
  const candidate = window as {
    readonly entries?: unknown;
    readonly revision?: unknown;
  };
  return (
    Array.isArray(candidate.entries) &&
    candidate.entries.length === 0 &&
    candidate.revision === 0
  );
}

/**
 * Guarded read of a binding's `eventSource`. A released reference (or a
 * host-shaped getter) can throw; that is an absent source, not a crash in a
 * promise continuation.
 */
function sourceOf(value: unknown): ConversationSourceLike | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const source = (value as { readonly eventSource?: unknown }).eventSource;
    return typeof source === "object" && source !== null
      ? (source as ConversationSourceLike)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep the selected session's transcript fed from its event window. The
 * shell store is read, never written; only actual selection CHANGES move the
 * subscription (rows/presence updates re-emit the shell store constantly and
 * must not re-resolve the binding).
 *
 * The installed 0.2.x shape is RETAIN + REFERENCE + BINDING: `sessions.retain`
 * acquires a reference and starts the shared initial history opening, the
 * reference's `binding.eventSource` is the assembly feed, and `ready` settles
 * the open. A bare `binding(id)` borrow is the read-only fallback for a
 * runtime that serves one. Both replace the retired `sessions.open(id)`
 * selection verb; keeping the old verb would leave the pane permanently
 * unavailable. The reference is held while the session is selected (a send
 * needs a retained scope) and released on deselect/dispose.
 */
export function bindConversationFeed(
  conversation: ConversationStore,
  sessions: ClientSessionsLike,
  shell: ShellSelectionSource,
): ConversationFeedBinding {
  let current: string | null = null;
  let unsubscribeWindow: (() => void) | undefined;
  let held: ClientSessionReferenceLike | undefined;
  /** Invalidates in-flight `ready` continuations after a selection change. */
  let generation = 0;
  /** The source whose window is currently applied, and its re-sync. */
  let attachedSource: ConversationSourceLike | undefined;
  let syncAttached: (() => void) | undefined;

  /** Drop the window subscription without touching the held reference. */
  const closeWindow = (): void => {
    const unsubscribe = unsubscribeWindow;
    unsubscribeWindow = undefined;
    attachedSource = undefined;
    syncAttached = undefined;
    if (typeof unsubscribe === "function") {
      try {
        unsubscribe();
      } catch {
        // A broken disposer is contained: the pane degrades, nothing escapes.
      }
    }
  };

  const detach = (): void => {
    generation += 1;
    closeWindow();
    const reference = held;
    held = undefined;
    if (reference !== undefined && typeof reference.release === "function") {
      try {
        reference.release();
      } catch {
        // Same containment: release is the host's cleanup, not our verdict.
      }
    }
  };

  /**
   * Apply one readable source and follow its publications, if it has any.
   * `settled()` says whether the reference's initial open has completed; an
   * empty revision-0 window before then is provisional (waiting), not empty.
   */
  const attachSource = (
    sessionId: string,
    source: ConversationSourceLike,
    settled: () => boolean,
  ): void => {
    if (
      source === null ||
      typeof source !== "object" ||
      typeof source.getSnapshot !== "function"
    ) {
      conversation.markUnavailable(sessionId);
      return;
    }
    attachedSource = source;
    const sync = (): void => {
      let snapshot: ReturnType<ConversationSourceLike["getSnapshot"]>;
      try {
        snapshot = source.getSnapshot();
      } catch {
        // A throwing host reader is an unreadable window, not an escape into
        // the shell's selection notify loop.
        conversation.markUnavailable(sessionId);
        return;
      }
      if (!settled() && isEmptyInitialWindow(snapshot)) {
        conversation.markWaiting(sessionId);
        return;
      }
      try {
        conversation.applyWindow(sessionId, snapshot);
      } catch {
        // The store isolates its own subscribers, so a throw here means the
        // store itself failed. Do NOT reroute into `markUnavailable`: that
        // emits again and re-enters the same failing listener loop.
      }
    };
    syncAttached = sync;
    sync();
    // `subscribe` is optional on a snapshot-only face, and a runtime may
    // return a non-callable from it. Capture the return and only treat it as
    // a disposer when it is a function; otherwise the pane applies once and
    // degrades honestly (never an uncallable value at dispose time).
    let unsubscribe: unknown;
    try {
      unsubscribe =
        typeof source.subscribe === "function" ? source.subscribe(sync) : undefined;
    } catch {
      unsubscribe = undefined;
    }
    unsubscribeWindow =
      typeof unsubscribe === "function"
        ? (unsubscribe as () => void)
        : undefined;
  };

  const follow = (): void => {
    const selection = shell.getBox().state.selection;
    const selected =
      selection.kind === "session" ? selection.sessionId : null;
    if (selected === current) return;
    detach();
    current = selected;
    if (selected === null) return;
    const token = generation;

    // Acquire first: `retain` is the 0.2.x acquisition-and-open verb. A
    // throwing retain is an honest unavailable pane, never a crash.
    let binding: ClientSessionBindingLike | undefined;
    if (typeof sessions.retain === "function") {
      try {
        const reference = sessions.retain(selected, {
          source: CONVERSATION_FEED_SOURCE,
        });
        if (reference !== null && typeof reference === "object") {
          held = reference;
          binding = reference.binding;
        }
      } catch {
        // fall through to the borrow fallback / honest unavailability
      }
    }
    if (binding === undefined && typeof sessions.binding === "function") {
      try {
        binding = sessions.binding(selected);
      } catch {
        binding = undefined;
      }
    }

    // The binding may only be readable once the reference's initial open
    // settles (`reference.ready`). Observe that promise ALWAYS — even when an
    // eventSource is already present — because the window it carries may be
    // the provisional empty revision 0, and because a rejection must become
    // the honest unavailable state instead of an unhandled rejection.
    let ready: unknown;
    try {
      ready = held?.ready;
    } catch {
      ready = undefined; // a throwing ready read is no wait at all
    }
    const awaitable =
      ready !== undefined &&
      typeof (ready as PromiseLike<unknown>).then === "function";
    let readySettled = !awaitable;

    /** The held reference's source, guarded against post-release reads. */
    const heldSource = (): ConversationSourceLike | undefined => {
      try {
        return sourceOf(held?.binding);
      } catch {
        return undefined;
      }
    };

    if (awaitable) {
      void Promise.resolve(ready).then(
        (settledValue) => {
          if (token !== generation || current !== selected) return;
          readySettled = true;
          const late = sourceOf(settledValue) ?? heldSource();
          if (late !== undefined && late !== attachedSource) {
            // The settled binding is the authority: replace the provisional
            // window subscription with the live one.
            closeWindow();
            attachSource(selected, late, () => readySettled);
            return;
          }
          if (syncAttached !== undefined) {
            // Re-read the already-attached source now that the provisional
            // empty window is allowed to settle into `ready` (empty).
            syncAttached();
            return;
          }
          if (late !== undefined) {
            attachSource(selected, late, () => readySettled);
            return;
          }
          conversation.markUnavailable(selected);
        },
        () => {
          if (token !== generation || current !== selected) return;
          // The initial open failed. This is unavailable even when an
          // eventSource was handed out before the rejection; stop following
          // its provisional window.
          readySettled = false;
          closeWindow();
          conversation.markUnavailable(selected);
        },
      );
    }

    const source = sourceOf(binding);
    if (source !== undefined) {
      attachSource(selected, source, () => readySettled);
      return;
    }
    if (awaitable) return; // wait for `ready` to name the binding

    // No acquisition path this runtime serves: the pane is honestly
    // unavailable. The reason is structural (no retain/binding face), not a
    // transient failure, so there is no retry model (ADR-0018 U-A).
    conversation.markUnavailable(selected);
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
