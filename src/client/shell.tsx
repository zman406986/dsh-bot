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
 * - blocked chip — the session's waiting marker with the design-17 §4.1
 *   precedence (a pending ask outranks a landed-undelivered result),
 *   localized through the SHARED `roster.blocked.*` / `roster.landed` keys
 *   (one copy vocabulary, never a second);
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
 * Presentation only: the shell never spawns, steers, stops a worker, or
 * sends — every intent stays with the host seats / verified transports.
 * Since ticket 101 (ADR-0021 decision 3) the sidebar additionally carries
 * the session-lifecycle seats (add = `/dispatcher-start` in a chosen
 * session, delete after confirmation = `/dispatcher-stop`): the shell only
 * gates and routes the click; the composition owns the transports, and the
 * worker/turn no-stop posture is untouched (the U-G amendment is for
 * dispatcher sessions ONLY). Pane decisions
 * come from the pure `describeShellPanes`; this component only maps them to
 * seats. Rendering is covered by build + typecheck (S8: no DOM harness); the
 * store and pane logic are asserted purely in tests.
 *
 * Styles ship as a plain string rendered into a <style> element by the
 * component itself (same discipline as the panel/capsule): every class is
 * `multitask-dispatcher-` prefixed, every colour resolves through a host
 * `--dsw-alias-*` token (ticket 49's contract — no private palette), text
 * hierarchy is opacity-based, there is no animation at all, and no text
 * colour is set (the shell inherits the host's theme colour).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ComponentType, JSX } from "react";
import type { TranslateFn } from "./overlay.js";
import { formatTemplate, rosterBlockedKey } from "./roster-store.js";
import {
  describeAddPicker,
  describeRowPreview,
  describeShellPanes,
  describeShellSidebar,
  SHELL_DELETE_CONFIRM_MS,
  SHELL_DELETE_IDLE,
  shellDeletePress,
  type DispatcherShellStore,
  type ShellDeleteArmState,
  type ShellRowView,
  type ShellState,
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
.multitask-dispatcher-shell__row-actions{display:flex;align-self:flex-start;gap:10px}
.multitask-dispatcher-shell__row-copy{display:none}
.multitask-dispatcher-shell__list li:hover .multitask-dispatcher-shell__row-copy,.multitask-dispatcher-shell__row-actions:focus-within .multitask-dispatcher-shell__row-copy{display:inline}
.multitask-dispatcher-shell__row-actions button{border:none;padding:0;background:transparent;color:inherit;font:inherit;font-size:11px;opacity:.55;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.multitask-dispatcher-shell__row-actions button:hover{opacity:.9;text-decoration:underline}
.multitask-dispatcher-shell__row-actions button[data-armed="true"]{opacity:1;color:var(--dsw-alias-state-warn-primary)}
.multitask-dispatcher-shell__add{position:sticky;bottom:0;z-index:1;margin-top:auto;padding:6px 6px 2px;border-top:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3)}
.multitask-dispatcher-shell__add-toggle{width:100%;border:none;padding:4px 2px;background:transparent;color:inherit;font:inherit;font-size:12px;opacity:.7;cursor:pointer;text-align:left}
.multitask-dispatcher-shell__add-toggle:hover{opacity:1;text-decoration:underline}
.multitask-dispatcher-shell__add-list{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:2px}
.multitask-dispatcher-shell__add-option{width:100%;border:1px solid transparent;border-radius:8px;padding:5px 8px;background:transparent;color:inherit;font:inherit;font-size:12px;opacity:.85;cursor:pointer;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.multitask-dispatcher-shell__add-option:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 75%,transparent);border-color:var(--dsw-alias-border-l3);opacity:1}
.multitask-dispatcher-shell__add-empty{font-size:11px;opacity:.6;padding:4px 2px}
.multitask-dispatcher-shell__main{display:flex;flex-direction:column;min-width:0;min-height:0}
.multitask-dispatcher-shell__main-header{padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l3);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.multitask-dispatcher-shell__conversation-pending{padding:14px;opacity:.6}
.multitask-dispatcher-shell__noselection{margin:auto;opacity:.6;padding:14px}
.multitask-dispatcher-shell__right{min-height:0;overflow-y:auto;border-left:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);padding:10px}
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
 * Localize the waiting marker: the blocked phrase per access class (the
 * shared `roster.blocked.*` copy the panel uses — names only, never a
 * secret value), or the landed marker. Unknown class templates fall back to
 * the generic phrase (copy-drift guard, same as the panel).
 */
export function waitingPhrase(
  t: TranslateFn,
  waiting: Exclude<ShellWaitingMarker, null>,
): string {
  if (waiting.kind === "landed") return t("roster.landed");
  const template = t(rosterBlockedKey(waiting.blocked.class));
  const safe =
    template === rosterBlockedKey(waiting.blocked.class)
      ? t("roster.blocked.other")
      : template;
  return formatTemplate(safe, { target: waiting.blocked.target });
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
   * row selection, with the same id — the composition wires this to the
   * host's `sessions.open(id)` ("selection via open(id) semantics"). The
   * component itself never touches the sessions service.
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
  /**
   * Ticket 101 (ADR-0021 decision 3): the ADD seat — called with a session
   * id chosen from the add picker (a feed-delivered session the mirrors do
   * not flag as a dispatcher). The composition executes `/dispatcher-start`
   * in that session through the composer's own command transaction. ABSENT,
   * the picker is not rendered (an offline/stub shell shows no dead control).
   */
  readonly onAddDispatcherSession?: (sessionId: string) => void;
  /**
   * Ticket 101 (ADR-0021 decision 3): the DELETE seat — called with a
   * dispatcher session id ONLY after the row's two-step confirmation
   * (armed-window) completed. The composition executes `/dispatcher-stop` in
   * that session: the binding deactivates through the host dispose path
   * (tools unbound, mirror cleared); the dsh chat itself is NEVER disposed.
   * ABSENT, no delete affordance renders.
   */
  readonly onDeleteDispatcherSession?: (sessionId: string) => void;
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
 * Ticket 101 (ADR-0021 decision 3): dispatcher rows with a delete seat also
 * render the DELETE affordance in the same hover-revealed actions row —
 * two-step confirmation (armed window, `shellDeletePress`), never a
 * single-click fire; the armed label reverts when the window expires. The
 * seat itself is the composition's command transaction; the row only gates.
 */
function ShellRow(props: {
  t: TranslateFn;
  row: ShellRowView;
  onSelect: (sessionId: string) => void;
  onCopyId: (sessionId: string) => void;
  onDelete?: ((sessionId: string) => void) | undefined;
}): JSX.Element {
  const { t, row, onSelect, onCopyId, onDelete } = props;
  const [arm, setArm] = useState<ShellDeleteArmState>(SHELL_DELETE_IDLE);
  const armedHere = arm.armedSessionId === row.sessionId;
  // Visual honesty: the armed ("confirm") label never outlives the window
  // that would confirm it — a timer reverts the row to its idle label. (The
  // press decision itself re-checks the window against the clock, so a
  // lapsed timer can never confirm.)
  useEffect(() => {
    if (!armedHere) return;
    const remaining = arm.armedAtMs + SHELL_DELETE_CONFIRM_MS - Date.now();
    if (remaining <= 0) {
      setArm(SHELL_DELETE_IDLE);
      return;
    }
    const timer = setTimeout(() => setArm(SHELL_DELETE_IDLE), remaining);
    return () => clearTimeout(timer);
  }, [armedHere, arm.armedAtMs]);
  const presence = row.presence;
  const presenceAvailable = row.presenceAvailable;
  const dot = describePresenceDot(row);
  const preview = describeRowPreview(row, presenceAvailable);
  const onDeleteClick = () => {
    const sessionId = row.sessionId;
    const press = shellDeletePress(arm, sessionId, Date.now());
    setArm(press.state);
    if (press.action === "confirm") onDelete?.(sessionId);
  };
  return (
    <li>
      <button
        type="button"
        className={`${SHELL_CLASS}__row`}
        data-session-id={row.sessionId}
        data-dispatcher={row.dispatcher ? "true" : "false"}
        data-selected={row.selected ? "true" : "false"}
        data-presence={dot}
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
                  {formatTemplate(t("shell.row.working"), {
                    count: String(presence.working),
                  })}
                </span>
              ) : null}
              {presence.needsYou > 0 ? (
                <span className={`${SHELL_CLASS}__chip--needs-you`}>
                  {formatTemplate(t("shell.row.needs-you"), {
                    count: String(presence.needsYou),
                  })}
                </span>
              ) : null}
              {presence.finished > 0 ? (
                <span className={`${SHELL_CLASS}__chip--finished`}>
                  {formatTemplate(t("shell.row.finished"), {
                    count: String(presence.finished),
                  })}
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
        <span className={`${SHELL_CLASS}__row-actions`}>
          <button
            type="button"
            className={`${SHELL_CLASS}__row-copy`}
            data-copy-id={row.sessionId}
            aria-label={t("shell.row.copy-id")}
            title={row.sessionId}
            onClick={() => onCopyId(row.sessionId)}
          >
            {row.sessionId}
          </button>
          {onDelete !== undefined ? (
            <button
              type="button"
              className={`${SHELL_CLASS}__row-delete`}
              data-delete-id={row.sessionId}
              data-armed={armedHere ? "true" : "false"}
              aria-label={
                armedHere ? t("shell.row.delete-confirm") : t("shell.row.delete")
              }
              title={t("shell.row.delete-title")}
              onClick={onDeleteClick}
            >
              {armedHere ? t("shell.row.delete-confirm") : t("shell.row.delete")}
            </button>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

/**
 * The sidebar's ADD section (ticket 101, ADR-0021 decision 3): a toggle
 * revealing the picker of activatable sessions — feed-delivered rows the
 * mirrors do not flag as dispatchers ({@link describeAddPicker}). Empty
 * picker = the honest guidance (create the chat in dsh first); there is no
 * client-side "create chat" seam and none is simulated. Its own component
 * (own hook fiber, the ticket-88 discipline) because it holds the open/closed
 * state.
 */
function AddDispatcherSection(props: {
  t: TranslateFn;
  state: ShellState;
  onAdd: (sessionId: string) => void;
}): JSX.Element {
  const { t, state, onAdd } = props;
  const [open, setOpen] = useState(false);
  const picker = describeAddPicker(state);
  return (
    <div className={`${SHELL_CLASS}__add`}>
      <button
        type="button"
        className={`${SHELL_CLASS}__add-toggle`}
        data-add-toggle={open ? "open" : "closed"}
        aria-expanded={open ? "true" : "false"}
        onClick={() => setOpen(!open)}
      >
        {t("shell.add.label")}
      </button>
      {open ? (
        picker.kind === "ready" ? (
          <ul className={`${SHELL_CLASS}__add-list`}>
            {picker.candidates.map((row) => (
              <li key={row.sessionId}>
                <button
                  type="button"
                  className={`${SHELL_CLASS}__add-option`}
                  data-add-id={row.sessionId}
                  title={row.sessionId}
                  onClick={() => {
                    setOpen(false);
                    onAdd(row.sessionId);
                  }}
                >
                  {row.title}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className={`${SHELL_CLASS}__add-empty`} data-add-empty="true">
            {t("shell.add.empty")}
          </div>
        )
      ) : null}
    </div>
  );
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
    const sidebar = describeShellSidebar(box.state, Date.now());
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
                  onDelete={hosts.onDeleteDispatcherSession}
                />
              ))}
            </ul>
          )}
          {hosts.onAddDispatcherSession !== undefined ? (
            <AddDispatcherSection
              t={t}
              state={box.state}
              onAdd={hosts.onAddDispatcherSession}
            />
          ) : null}
        </aside>
        <section className={`${SHELL_CLASS}__main`}>
          {panes.main.kind === "no-selection" ? (
            hosts.onboarding ? (
              // Ticket 68: the onboarding seat replaces the bare no-selection
              // copy while the first-run flow is unsuppressed; it degrades to
              // the same copy itself once suppressed (one vocabulary).
              // Ticket 88: RENDERED as an element — its hooks must live in
              // their own fiber, never inlined into the shell's.
              <hosts.onboarding />
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
              {hosts.conversation ? (
                <hosts.conversation sessionId={panes.main.sessionId} />
              ) : (
                <div className={`${SHELL_CLASS}__conversation-pending`}>
                  {t("shell.conversation.pending")}
                </div>
              )}
            </>
          )}
        </section>
        <aside className={`${SHELL_CLASS}__right`} data-pane="right">
          {panes.right.kind === "hosted-roster" && hosts.rosterPanel ? (
            <hosts.rosterPanel sessionId={panes.right.sessionId} />
          ) : null}
        </aside>
      </div>
    );
  };
}
