/**
 * Wrapper shell layout component (ticket 77, ADR-0020 slice 1).
 *
 * The three-pane whole-UI frame: sidebar (dispatcher sessions), main surface
 * (an honest "conversation surface not wired yet" placeholder until ticket
 * 80), right panel hosting the EXISTING roster panel component for the
 * selected session — hosted, not rebuilt (ADR-0020's re-host inventory rule;
 * the factory takes the host seat as `hosts.rosterPanel`).
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
import { formatTemplate } from "./roster-store.js";
import {
  describeShellPanes,
  describeShellSidebar,
  type DispatcherShellStore,
} from "./shell-store.js";

/** Class prefix — ours, namespaced, no shipped kit classes. */
export const SHELL_CLASS = "multitask-dispatcher-shell";

/**
 * Shell styles (ticket 77, themed per ticket 49). Colours referenced:
 * `--dsw-alias-bg-layer-1/3` (surfaces — layer-3 is the host's own floating-
 * surface value), `--dsw-alias-border-l3`, `--dsw-alias-label-tertiary`, and
 * the `state-*` family for presence chips — the same role mapping the roster
 * panel already uses.
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
.multitask-dispatcher-shell__row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.multitask-dispatcher-shell__row-presence{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;opacity:.8}
.multitask-dispatcher-shell__chip--working{color:var(--dsw-alias-state-business-primary)}
.multitask-dispatcher-shell__chip--needs-you{color:var(--dsw-alias-state-warn-primary)}
.multitask-dispatcher-shell__chip--finished{color:var(--dsw-alias-state-success-primary)}
.multitask-dispatcher-shell__chip--unavailable{color:var(--dsw-alias-label-tertiary)}
.multitask-dispatcher-shell__main{display:flex;flex-direction:column;min-width:0;min-height:0}
.multitask-dispatcher-shell__main-header{padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l3);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.multitask-dispatcher-shell__conversation-pending{padding:14px;opacity:.6}
.multitask-dispatcher-shell__noselection{margin:auto;opacity:.6;padding:14px}
.multitask-dispatcher-shell__right{min-height:0;overflow-y:auto;border-left:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);padding:10px}
`;

/** Host seats the shell fills with re-hosted components (ADR-0020). */
export interface ShellHosts {
  /**
   * The right-panel seat: given the selected session id, render the hosted
   * roster panel (the existing `createRosterPanel` output) or `null`. The
   * per-session feed binding is ticket 79's; until then the host seat may
   * render the panel only when its store has that session's data.
   */
  readonly rosterPanel?: (sessionId: string) => JSX.Element | null;
}

/** Sidebar row as a button (selection is a plain click, no router yet). */
function ShellRow(props: {
  t: TranslateFn;
  row: {
    sessionId: string;
    title: string;
    dispatcher: boolean;
    presence: {
      working: number;
      needsYou: number;
      finished: number;
    } | null;
    selected: boolean;
  };
  onSelect: (sessionId: string) => void;
}): JSX.Element {
  const { t, row, onSelect } = props;
  const presence = row.presence;
  return (
    <li>
      <button
        type="button"
        className={`${SHELL_CLASS}__row`}
        data-session-id={row.sessionId}
        data-dispatcher={row.dispatcher ? "true" : "false"}
        data-selected={row.selected ? "true" : "false"}
        onClick={() => onSelect(row.sessionId)}
      >
        <span className={`${SHELL_CLASS}__row-title`}>{row.title}</span>
        <span className={`${SHELL_CLASS}__row-presence`}>
          {presence === null ? (
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
            </>
          )}
        </span>
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
    const sidebar = describeShellSidebar(box.state);
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
                  onSelect={(sessionId) => store.select(sessionId)}
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
