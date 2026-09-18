/**
 * Wrapper shell sessions-feed binding (ticket 79, ADR-0020 slice 3).
 *
 * The sidebar's ROWS are the standard sessions feed (`ctx.sessions.list`,
 * `docs/research/wrapper-vehicle-seams.md` Finding 1 — "the useSessions
 * standard feed (list rows + current selection; read face)"); the dispatcher
 * FLAG and the presence come from our per-session roster mirrors
 * (`shell-store.ts`). This module is the pure projection between the two,
 * plus the subscribe/open binding the shell composition (ticket 78's
 * registration) will call — offline-tested here over structural fakes, no
 * live seam.
 *
 * Structural shapes only (no import from `@deepseek-ai/*`): they mirror the
 * installed `SessionListState` / `SessionSummary` contract
 * (dsh-api-session-controller `lib/types/client/sessions/service.d.ts:31-78`)
 * down to the fields the sidebar needs.
 *
 * Projection honesty rules:
 * - rows project `displayTitle` (the host's human-facing label: durable
 *   title, project basename, then session id — never blank), falling back to
 *   `title`, then the raw id;
 * - subagent-origin rows are excluded: workers are leaves (ADR-0018
 *   conformance) and their presence lives in the roster panel, not as
 *   dispatcher rows;
 * - rows the feed names but has not delivered a summary for are skipped —
 *   an id without a title is not a lie-free row;
 * - no `dispatcher` flag is projected: in production the flag is derived
 *   from our per-session roster mirrors (`shell-store.ts`), the per-session
 *   activation state (ticket 76's keyed publishes);
 * - a snapshot without an `ids` array projects nothing and — in the
 *   binding — authorizes NO removals: a malformed feed snapshot must never
 *   wipe the roster.
 */
import type {
  DispatcherShellStore,
  ShellSessionInput,
} from "./shell-store.js";

/** The minimal `SessionSummary` face the projection reads. */
export interface ShellFeedRowLike {
  readonly id: string;
  readonly displayTitle?: string;
  readonly title?: string;
  /** Coarse durable origin; `"subagent"` rows are worker runs, not chats. */
  readonly origin?: string;
}

/** The minimal `SessionListState` face the projection reads. */
export interface ShellFeedSnapshotLike {
  readonly ids?: readonly string[];
  readonly byId?: Readonly<Record<string, ShellFeedRowLike>>;
  readonly current?: string;
}

/** The minimal `ctx.sessions` face the binding reads (read face only). */
export interface ShellSessionsFeedLike {
  readonly list: {
    getSnapshot(): ShellFeedSnapshotLike;
    /** Optional: without it the binding syncs once and never live. */
    subscribe?(listener: () => void): () => void;
  };
}

/** Project one feed snapshot into shell store upsert inputs. */
export function sessionsFeedInputs(
  feed: ShellFeedSnapshotLike,
): ShellSessionInput[] {
  const ids = feed.ids;
  if (!Array.isArray(ids)) return [];
  const inputs: ShellSessionInput[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) continue;
    const row = feed.byId?.[id];
    if (row === undefined || row === null) continue;
    if (row.origin === "subagent") continue;
    const title =
      row.displayTitle ??
      row.title ??
      id;
    inputs.push({ sessionId: id, title });
  }
  return inputs;
}

/** Hooks the composition can use to ride the host's selection verb. */
export interface ShellFeedBindingHooks {
  /**
   * Called AFTER the store accepted a selection, with the same id — the
   * composition wires this to `ctx.sessions.open(id)` ("selection via
   * `open(id)` semantics", ticket 79). Never called for unknown ids: the
   * host's `open` "fails loud" on them, so the guard comes first.
   */
  readonly onOpen?: (sessionId: string) => void;
}

/** What `bindShellSessionsFeed` returns. */
export interface ShellFeedBinding {
  /**
   * Select a session the store knows: store selection + the host `open`
   * hook together. Unknown ids are refused on BOTH sides (no store change,
   * no host call) — never invented.
   */
  open(sessionId: string): void;
  /** Stop syncing the feed. */
  dispose(): void;
}

/**
 * Bind the store to the sessions feed: sync now, live on every feed
 * notification, and remove rows the feed dropped. With a malformed snapshot
 * (`ids` not an array) nothing is upserted and nothing is removed.
 */
export function bindShellSessionsFeed(
  store: DispatcherShellStore,
  sessions: ShellSessionsFeedLike,
  hooks: ShellFeedBindingHooks = {},
): ShellFeedBinding {
  const sync = (): void => {
    const snapshot = sessions.list.getSnapshot();
    const ids = snapshot.ids;
    if (!Array.isArray(ids)) return; // malformed: no lies, no wipes
    store.upsertSessions(sessionsFeedInputs(snapshot));
    const live = new Set(ids);
    const gone = store.getBox().state.order.filter((id) => !live.has(id));
    if (gone.length > 0) store.removeSessions(gone);
  };

  sync();
  const disposeFeed =
    sessions.list.subscribe !== undefined
      ? sessions.list.subscribe(() => sync())
      : () => {};

  return {
    open(sessionId) {
      if (!store.getBox().state.rows.has(sessionId)) return;
      store.select(sessionId);
      hooks.onOpen?.(sessionId);
    },
    dispose() {
      disposeFeed();
    },
  };
}
