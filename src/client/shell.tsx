/**
 * Wrapper shell layout component (ticket 77, ADR-0020 slice 1; sidebar row
 * presence re-host ticket 79, ADR-0020 slice 3).
 *
 * Ticket 89 (2026-09-19): the ticket-78 STAGING launcher affordance — the
 * `shell.overlay` chip (`createShellLauncher`, `SHELL_LAUNCHER_CSS`,
 * `SHELL_LAUNCHER_CLASS`) that opened the shell's `main` page — was retired
 * at the ticket-78 cutover and is now DELETED; nothing consumed it. The
 * `main` page registration itself stays (the pinned staging contract,
 * dormant behind the frame election and self-restoring on abdication; its
 * live contracts live in `shell-mount.ts`, composed in `index.ts`).
 *
 * The three-pane whole-UI frame: sidebar (dispatcher sessions), main surface
 * (an honest "conversation surface not wired yet" placeholder until ticket
 * 80), right panel hosting the EXISTING roster panel component for the
 * selected session — hosted, not rebuilt (ADR-0020's re-host inventory rule;
 * the factory takes the host seat as `hosts.rosterPanel`).
 *
 * Ticket 79 re-hosts the ticket-27/28 presence semantics onto the sidebar
 * rows at SESSION granularity (the panel keeps the per-worker picture):
 * - status dot — aggregate session visual (working / needs-you / finished /
 *   idle), the `state-*` token roles the panel's dots already use;
 * - waiting chip — the session's landed-undelivered marker, localized
 *   through the SHARED `roster.landed` key (one copy vocabulary, never a
 *   second);
 * - activity/finished markers — the per-session counters (working / needs
 *   you / finished), the session-granularity re-host of the panel's activity
 *   line;
 * - hover preview — waiting reason > last entry, per the reference
 *   precedence. The draft tier is a recorded gap (ADR-0018 U-B: no per-agent
 *   drafts exist). Revealed purely in CSS (`:hover`/`:focus-visible`), no
 *   animation.
 * Unread/attention stays pull-only (no push seam exists; ticket 27's
 * honesty): the needs-you counter is the marker, nothing interrupts.
 * Failure states are honest copy only: empty / presence-unavailable, and
 * deliberately RETRY-LESS — no retry control, no reconnect banner
 * (ADR-0018 U-A; see ticket 82 for the ADR-0020 row tension).
 *
 * Ticket 70 (peer tier placement): each dispatcher row carries a
 * copy-session-id affordance — the session id is what a peer addresses
 * `send_peer` with, and the sidebar roster is its source (no directory;
 * C13 holds). The affordance shows the id verbatim and copies it through
 * the host clipboard seam; nothing else about peer traffic surfaces here.
 *
 * Presentation only: the shell never spawns, steers, stops, or sends — every
 * intent stays with the later slices' verified transports. Pane decisions
 * come from the pure `describeShellPanes`; this component only maps them to
 * seats. Rendering is covered by build + typecheck (S8: no DOM harness); the
 * store and pane logic are asserted purely in tests.
 *
 * Styles ship as a plain string rendered into a <style> element by the
 * component itself (same discipline as the panel/capsule): every class is
 * `multitask-dispatcher-` prefixed, every colour resolves through a host
 * `--dsw-alias-*` token (ticket 49's contract — no private palette), text
 * hierarchy is opacity-based, there is no animation at all, and the only text
 * colour set is the state-error token on a seat's failure line (the shell
 * otherwise inherits the host's theme colour).
 *
 * Each host seat renders behind its own error boundary, and the sidebar's
 * staleness clock ticks with the panel's cadence: one broken seat or one aged
 * snapshot degrades to an honest line instead of taking the entry down.
 */
import { Component, useEffect, useState, useSyncExternalStore } from "react";
import type { ComponentType, JSX, ReactNode } from "react";
import type { TranslateFn } from "./overlay.js";
import {
  ROSTER_STALE_RECHECK_MS,
  formatCount,
} from "./roster-store.js";
import {
  describeRowPreview,
  describeShellPanes,
  describeShellSidebar,
  type DispatcherShellStore,
  type ShellRowView,
  type ShellWaitingMarker,
} from "./shell-store.js";

/** Class prefix — ours, namespaced, no shipped kit classes. */
export const SHELL_CLASS = "multitask-dispatcher-shell";

/**
 * Shell styles (tickets 77 + 79, themed per ticket 49). Colours referenced:
 * `--dsw-alias-bg-layer-1/3` (surfaces — layer-3 is the host's own floating-
 * surface value), `--dsw-alias-border-l3`, `--dsw-alias-label-tertiary`, and
 * the `state-*` family for presence dots/chips — the same role mapping the
 * roster panel already uses.
 */
export const SHELL_CSS = `
.multitask-dispatcher-shell{display:grid;grid-template-columns:minmax(180px,240px) minmax(0,1fr) minmax(200px,280px);width:100%;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:1.5}
.multitask-dispatcher-shell__sidebar{display:flex;flex-direction:column;gap:6px;min-height:0;padding:10px 8px;background:var(--dsw-alias-bg-layer-3);border-right:1px solid var(--dsw-alias-border-l3);overflow-y:auto}
.multitask-dispatcher-shell__sidebar-title{font-weight:600;opacity:.75;padding:0 6px}
.multitask-dispatcher-shell__empty{opacity:.7;padding:0 6px}
.multitask-dispatcher-shell__list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.multitask-dispatcher-shell__row{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:8px;border:1px solid transparent;cursor:pointer;min-width:0;text-align:left;background:transparent;color:inherit;font:inherit}
.multitask-dispatcher-shell__row:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 75%,transparent)}
.multitask-dispatcher-shell__row[data-selected="true"]{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l3)}
.multitask-dispatcher-shell__row-head{display:flex;align-items:center;gap:6px;min-width:0}
.multitask-dispatcher-shell__dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.multitask-dispatcher-shell__dot[data-presence="working"]{background:var(--dsw-alias-state-business-primary)}
.multitask-dispatcher-shell__dot[data-presence="needs-you"]{background:var(--dsw-alias-state-warn-primary)}
.multitask-dispatcher-shell__dot[data-presence="finished"]{background:var(--dsw-alias-state-success-primary)}
.multitask-dispatcher-shell__row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.multitask-dispatcher-shell__row-presence{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;opacity:.8}
.multitask-dispatcher-shell__chip--working{color:var(--dsw-alias-state-business-primary)}
.multitask-dispatcher-shell__chip--needs-you{color:var(--dsw-alias-state-warn-primary)}
.multitask-dispatcher-shell__chip--finished{color:var(--dsw-alias-state-success-primary)}
.multitask-dispatcher-shell__chip--unavailable{color:var(--dsw-alias-label-tertiary)}
.multitask-dispatcher-shell__chip--waiting{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 6px;border-radius:8px;border:1px solid currentColor;color:var(--dsw-alias-state-warn-primary)}
.multitask-dispatcher-shell__row-preview{display:none;opacity:.6;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.multitask-dispatcher-shell__row:hover .multitask-dispatcher-shell__row-preview,.multitask-dispatcher-shell__row:focus-visible .multitask-dispatcher-shell__row-preview{display:block}
.multitask-dispatcher-shell__row-copy{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer}
.multitask-dispatcher-shell__row-copy:hover{opacity:.9;text-decoration:underline}
.multitask-dispatcher-shell__list li:hover .multitask-dispatcher-shell__row-copy,.multitask-dispatcher-shell__list li:focus-within .multitask-dispatcher-shell__row-copy{position:static;width:auto;height:auto;max-width:100%;margin:2px 8px 0;padding:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;clip:auto;clip-path:none;opacity:.55}
.multitask-dispatcher-shell__list li:hover .multitask-dispatcher-shell__row-copy:hover,.multitask-dispatcher-shell__list li:focus-within .multitask-dispatcher-shell__row-copy:hover{opacity:.9;text-decoration:underline}
.multitask-dispatcher-shell__main{display:flex;flex-direction:column;min-width:0;min-height:0}
.multitask-dispatcher-shell__main-header{padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l3);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.multitask-dispatcher-shell__conversation-pending{padding:14px;opacity:.6}
.multitask-dispatcher-shell__noselection{margin:auto;opacity:.6;padding:14px}
.multitask-dispatcher-shell__right{min-height:0;overflow-y:auto;border-left:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);padding:10px}
.multitask-dispatcher-shell__seat-failed{margin:auto;padding:14px;opacity:.7;color:var(--dsw-alias-state-error-primary)}
`;

/**
 * The session's aggregate dot state (pure; ticket 79). Same role vocabulary
 * as the panel's visuals, collapsed to session granularity; "unavailable"
 * is the honest no-live-data state, "idle" a live snapshot with nothing in
 * any section (e.g. the fresh empty roster right after activation).
 */
export function describePresenceDot(
  row: Pick<ShellRowView, "presence" | "presenceAvailable">,
): "working" | "needs-you" | "finished" | "idle" | "unavailable" {
  const presence = row.presence;
  if (!row.presenceAvailable || presence === null) return "unavailable";
  if (presence.working > 0) return "working";
  if (presence.needsYou > 0) return "needs-you";
  if (presence.finished > 0) return "finished";
  return "idle";
}

/**
 * Localize the waiting marker. Ticket 174 / ADR-0033 removed the blocked-ask
 * variant with the access-ask feature, so the landed marker is the only
 * waiting state left.
 */
export function waitingPhrase(
  t: TranslateFn,
  _waiting: Exclude<ShellWaitingMarker, null>,
): string {
  return t("roster.landed");
}

/**
 * Host seats the shell fills with re-hosted components (ADR-0020).
 *
 * TICKET-88 DISCIPLINE: every seat is a COMPONENT the shell renders as an
 * element (`<hosts.seat />`), never a function the shell calls. A called
 * component's hooks attach to the SHELL's own hook list, so the shell's
 * hook count would depend on the render branch — the live pass-4 crash
 * (React minified #300, "Rendered fewer hooks than expected" on the vendored
 * React 19.3) died exactly there: selecting a session dropped the inlined
 * onboarding hooks mid-fiber and the whole `root` entry abdicated. Rendered
 * as elements, each seat keeps its own fiber: mounting and unmounting a
 * seat across a branch flip is ordinary React, never a hook-count change.
 */
export interface ShellHosts {
  /**
   * The right-panel seat: rendered with the selected session id, it shows
   * the hosted roster panel (the existing `createRosterPanel` output) or
   * `null`. The per-session feed binding is ticket 79's; until then the
   * host seat may render the panel only when its store has that session's
   * data.
   */
  readonly rosterPanel?: ComponentType<{ readonly sessionId: string }>;
  /**
   * The main-seat conversation pane (ticket 80): rendered with the selected
   * session id, it shows the text-only conversation surface bound to that
   * session's event window and composer actions. The shell itself never
   * touches the conversation services — the seat is the composition's (same
   * discipline as `rosterPanel`). When absent the pane stays the honest
   * pending copy.
   */
  readonly conversation?: ComponentType<{ readonly sessionId: string }>;
  /**
   * Selection ride-along (ticket 79): called AFTER the store accepted a
   * row selection, with the same id. 0.2.x has no host `open(id)` verb —
   * selection is view-owned and the composition's conversation feed retains
   * the selected session from the store change — so this is the
   * composition's post-selection seam, not a host call. The component itself
   * never touches the sessions service.
   */
  readonly onSelectSession?: (sessionId: string) => void;
  /**
   * The first-run onboarding seat (ticket 68): rendered in the no-selection
   * main state in place of the bare copy. The seat itself decides between
   * the beats and the settled no-selection copy from the suppression state
   * (settings-namespace seen record / dispatcher mirrors), so the shell
   * stays presentation-only. IN-SHELL by construction — the seat lives in
   * this frame, never in a staging-only slot, so it survives the ticket-78
   * cutover.
   */
  readonly onboarding?: ComponentType | undefined;
  /**
   * Ticket 70 (peer tier placement): the clipboard writer behind the
   * dispatcher rows' copy-session-id affordance — the session id is what a
   * peer addresses `send_peer` with, and the sidebar roster row is its
   * source. The composition wires the host clipboard; ABSENT, the shell
   * falls back to a best-effort `navigator.clipboard` write whose failure is
   * contained (the id stays readable on the button and its title either way
   * — no fake success is ever shown).
   */
  readonly copyToClipboard?: (text: string) => void | Promise<void>;
}

/** Best-effort default clipboard writer (host browser provides the seam). */
function defaultCopyToClipboard(text: string): void {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    // Clipboard unavailable: contained. The affordance's title still shows
    // the id verbatim — no fake success, no crash.
  }
}

/**
 * Sidebar row as a button (selection is a plain click, no router yet).
 * Ticket 70: dispatcher rows additionally render the copy-session-id
 * affordance OUTSIDE the row button (a button inside a button is invalid
 * HTML) — hover/focus-revealed, showing the id verbatim; clicking copies
 * it through the host seam.
 */
function ShellRow(props: {
  t: TranslateFn;
  row: ShellRowView;
  onSelect: (sessionId: string) => void;
  onCopyId: (sessionId: string) => void;
}): JSX.Element {
  const { t, row, onSelect, onCopyId } = props;
  const presence = row.presence;
  const presenceAvailable = row.presenceAvailable;
  const dot = describePresenceDot(row);
  const preview = describeRowPreview(row, presenceAvailable);
  return (
    <li>
      <button
        type="button"
        className={`${SHELL_CLASS}__row`}
        data-session-id={row.sessionId}
        data-dispatcher={row.dispatcher ? "true" : "false"}
        data-selected={row.selected ? "true" : "false"}
        data-presence={dot}
        aria-current={row.selected ? "true" : undefined}
        onClick={() => onSelect(row.sessionId)}
      >
        <span className={`${SHELL_CLASS}__row-head`}>
          <span
            className={`${SHELL_CLASS}__dot`}
            data-presence={dot}
            aria-hidden="true"
          />
          <span className={`${SHELL_CLASS}__row-title`}>{row.title}</span>
        </span>
        <span className={`${SHELL_CLASS}__row-presence`}>
          {!presenceAvailable || presence === null ? (
            <span className={`${SHELL_CLASS}__chip--unavailable`}>
              {t("shell.row.presence-unavailable")}
            </span>
          ) : (
            <>
              {presence.working > 0 ? (
                <span className={`${SHELL_CLASS}__chip--working`}>
                  {formatCount(t, "shell.row.working", presence.working)}
                </span>
              ) : null}
              {presence.needsYou > 0 ? (
                <span className={`${SHELL_CLASS}__chip--needs-you`}>
                  {formatCount(t, "shell.row.needs-you", presence.needsYou)}
                </span>
              ) : null}
              {presence.finished > 0 ? (
                <span className={`${SHELL_CLASS}__chip--finished`}>
                  {formatCount(t, "shell.row.finished", presence.finished)}
                </span>
              ) : null}
              {row.waiting !== null ? (
                <span className={`${SHELL_CLASS}__chip--waiting`}>
                  {waitingPhrase(t, row.waiting)}
                </span>
              ) : null}
            </>
          )}
        </span>
        {preview !== null ? (
          <span
            className={`${SHELL_CLASS}__row-preview`}
            data-preview-kind={preview.kind}
            aria-hidden="true"
          >
            {preview.kind === "waiting"
              ? waitingPhrase(t, preview.waiting)
              : preview.text}
          </span>
        ) : null}
      </button>
      {row.dispatcher ? (
        <button
          type="button"
          className={`${SHELL_CLASS}__row-copy`}
          data-copy-id={row.sessionId}
          aria-label={`${t("shell.row.copy-id")}: ${row.sessionId}`}
          title={row.sessionId}
          onClick={() => onCopyId(row.sessionId)}
        >
          {row.sessionId}
        </button>
      ) : null}
    </li>
  );
}

/**
 * One seat's failure line (ticket 88's hook-count lesson, now applied to
 * thrown renders): a seat is an ISOLATED fiber, so a component that throws
 * while rendering must not take the whole shell entry down. The boundary is a
 * small class because only an error boundary can catch a render failure; it
 * renders one honest line in the seat's place and nothing else (no stack
 * trace, no retry control — the shell has no retry model, ADR-0018 U-A).
 * Keys on each seat keep the failure local to the seat the user was looking
 * at: selecting another session remounts that seat's boundary with it.
 */
export class ShellSeatBoundary extends Component<
  { readonly t: TranslateFn; readonly children?: ReactNode },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    // The seat's own failure line is the report; nothing rethrows here.
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className={`${SHELL_CLASS}__seat-failed`} role="status">
          {this.props.t("shell.seat.failed")}
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Create the shell component bound to a translate seat, the session store,
 * and the host seats. Zero-prop function component; slot entries may hand
 * renderer-controlled props, which this component deliberately ignores.
 */
export function createDispatcherShell(
  t: TranslateFn,
  store: DispatcherShellStore,
  hosts: ShellHosts = {},
): () => JSX.Element {
  return () => {
    const box = useSyncExternalStore(store.subscribe, store.getBox);
    // Staleness is a VIEW outcome, so it needs a clock that advances without
    // a store emit: the mirror channel has no heartbeat and an aged snapshot
    // would otherwise keep rendering as live forever. The panel's rule and
    // cadence are reused (one stale rule total), cleaned up with the fiber.
    const [clock, setClock] = useState(() => Date.now());
    useEffect(() => {
      const handle = setInterval(
        () => setClock(Date.now()),
        ROSTER_STALE_RECHECK_MS,
      );
      return () => clearInterval(handle);
    }, []);
    const sidebar = describeShellSidebar(box.state, clock);
    const panes = describeShellPanes(box.state);

    const selectedTitle = (() => {
      if (panes.main.kind !== "conversation") return null;
      const sessionId = panes.main.sessionId;
      if (sidebar.kind !== "ready") return null;
      return sidebar.rows.find((row) => row.sessionId === sessionId)?.title ?? null;
    })();

    return (
      <div className={SHELL_CLASS} data-shell="dispatcher">
        <style>{SHELL_CSS}</style>
        <aside
          className={`${SHELL_CLASS}__sidebar`}
          aria-label={t("shell.sidebar.label")}
        >
          <div className={`${SHELL_CLASS}__sidebar-title`}>
            {t("shell.title")}
          </div>
          {sidebar.kind === "empty" ? (
            <div className={`${SHELL_CLASS}__empty`}>{t("shell.empty")}</div>
          ) : (
            <ul className={`${SHELL_CLASS}__list`}>
              {sidebar.rows.map((row) => (
                <ShellRow
                  key={row.sessionId}
                  t={t}
                  row={row}
                  onSelect={(sessionId) => {
                    store.select(sessionId);
                    hosts.onSelectSession?.(sessionId);
                  }}
                  onCopyId={(sessionId) => {
                    void (hosts.copyToClipboard ?? defaultCopyToClipboard)(
                      sessionId,
                    );
                  }}
                />
              ))}
            </ul>
          )}
        </aside>
        <section className={`${SHELL_CLASS}__main`}>
          {panes.main.kind === "no-selection" ? (
            hosts.onboarding ? (
              // Ticket 68: the onboarding seat replaces the bare no-selection
              // copy while the first-run flow is unsuppressed; it degrades to
              // the same copy itself once suppressed (one vocabulary).
              // Ticket 88: RENDERED as an element — its hooks must live in
              // their own fiber, never inlined into the shell's.
              <ShellSeatBoundary t={t} key="onboarding">
                <hosts.onboarding />
              </ShellSeatBoundary>
            ) : (
              <div className={`${SHELL_CLASS}__noselection`}>
                {t("shell.noselection")}
              </div>
            )
          ) : (
            <>
              <div className={`${SHELL_CLASS}__main-header`}>
                {selectedTitle ?? panes.main.sessionId}
              </div>
              {/* Ticket 80: the conversation pane is a HOST seat — the
                  composition binds it to the session's event window and the
                  send/older actions. Without a seat the pane keeps the
                  honest pending copy instead of an invented surface.
                  Ticket 88: rendered as an element (own hook fiber). */}
              <ShellSeatBoundary
                t={t}
                key={`conversation:${panes.main.sessionId}`}
              >
                {hosts.conversation ? (
                  <hosts.conversation sessionId={panes.main.sessionId} />
                ) : (
                  <div className={`${SHELL_CLASS}__conversation-pending`}>
                    {t("shell.conversation.pending")}
                  </div>
                )}
              </ShellSeatBoundary>
            </>
          )}
        </section>
        <aside className={`${SHELL_CLASS}__right`} data-pane="right">
          {panes.right.kind === "hosted-roster" && hosts.rosterPanel ? (
            <ShellSeatBoundary t={t} key={`roster:${panes.right.sessionId}`}>
              <hosts.rosterPanel sessionId={panes.right.sessionId} />
            </ShellSeatBoundary>
          ) : null}
        </aside>
      </div>
    );
  };
}
