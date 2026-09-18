/**
 * Wrapper shell layout component (ticket 77, ADR-0020 slice 1; sidebar row
 * presence re-host ticket 79, ADR-0020 slice 3).
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
 * hierarchy is opacity-based, there is no animation at all, and no text
 * colour is set (the shell inherits the host's theme colour).
 */
import { useSyncExternalStore } from "react";
import type { JSX } from "react";
import type { TranslateFn } from "./overlay.js";
import { formatTemplate, rosterBlockedKey } from "./roster-store.js";
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

/** Host seats the shell fills with re-hosted components (ADR-0020). */
export interface ShellHosts {
  /**
   * The right-panel seat: given the selected session id, render the hosted
   * roster panel (the existing `createRosterPanel` output) or `null`. The
   * per-session feed binding is ticket 79's; until then the host seat may
   * render the panel only when its store has that session's data.
   */
  readonly rosterPanel?: (sessionId: string) => JSX.Element | null;
  /**
   * Selection ride-along (ticket 79): called AFTER the store accepted a
   * row selection, with the same id — the composition wires this to the
   * host's `sessions.open(id)` ("selection via open(id) semantics"). The
   * component itself never touches the sessions service.
   */
  readonly onSelectSession?: (sessionId: string) => void;
}

/** Sidebar row as a button (selection is a plain click, no router yet). */
function ShellRow(props: {
  t: TranslateFn;
  row: ShellRowView;
  onSelect: (sessionId: string) => void;
}): JSX.Element {
  const { t, row, onSelect } = props;
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
    </li>
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
      if (panes.main.kind !== "conversation-pending") return null;
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
                />
              ))}
            </ul>
          )}
        </aside>
        <section className={`${SHELL_CLASS}__main`}>
          {panes.main.kind === "no-selection" ? (
            <div className={`${SHELL_CLASS}__noselection`}>
              {t("shell.noselection")}
            </div>
          ) : (
            <>
              <div className={`${SHELL_CLASS}__main-header`}>
                {selectedTitle ?? panes.main.sessionId}
              </div>
              {/* Honest skeleton state (ticket 77): the conversation surface
                  lands with ticket 80 — this copy says exactly that. */}
              <div className={`${SHELL_CLASS}__conversation-pending`}>
                {t("shell.conversation.pending")}
              </div>
            </>
          )}
        </section>
        <aside className={`${SHELL_CLASS}__right`} data-pane="right">
          {panes.right.kind === "hosted-roster" && hosts.rosterPanel
            ? hosts.rosterPanel(panes.right.sessionId)
            : null}
        </aside>
      </div>
    );
  };
}
