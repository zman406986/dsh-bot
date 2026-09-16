/**
 * Roster/status panel (ticket 21), replacing ticket 20's hello placeholder.
 *
 * Presentation only: the panel never spawns, steers, or stops anything — all
 * authority stays with the bound parent agent via the core (design-16 §3.4).
 * It renders the store's view model: title, one row per worker (title, verbatim
 * core FSM status label, todo link when present), the design-16 §6 empty
 * state, or the honest "unavailable" state — never a spinner that hangs.
 *
 * The component is a zero-prop function component created through a factory so
 * the translate seat and the data store are captured at registration time;
 * slot entries may be handed renderer-controlled props, which this panel
 * deliberately ignores. Rendering itself is covered by build + typecheck only
 * (S8: no DOM harness); the view model is asserted purely in tests.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { JSX } from "react";
import {
  ROSTER_STALE_RECHECK_MS,
  describeRosterPanel,
  type RosterStore,
} from "./roster-store.js";

/** Bound translate seat (`ctx.locale.bind(namespace)`), re-exported. */
export type { TranslateFn } from "./overlay.js";
import type { TranslateFn } from "./overlay.js";

/** Class prefix — ours, namespaced, no shipped kit classes. */
const PANEL_CLASS = "multitask-dispatcher-roster-panel";

/** Create the roster panel component bound to a translate seat and store. */
export function createRosterPanel(
  t: TranslateFn,
  store: RosterStore,
): () => JSX.Element {
  return () => {
    const box = useSyncExternalStore(store.subscribe, store.getBox);
    const view = describeRosterPanel(box.state, Date.now());

    // The mirror channel has no heartbeat: re-evaluate staleness on a slow
    // tick so an aged snapshot degrades to unavailable without a push.
    // React lifecycle only — never armed by the offline tests.
    useEffect(() => {
      const handle = setInterval(store.refresh, ROSTER_STALE_RECHECK_MS);
      return () => clearInterval(handle);
    }, [store]);

    return (
      <div className={PANEL_CLASS}>
        <div className={`${PANEL_CLASS}__title`}>{t("roster.title")}</div>
        {view.kind === "unavailable" ? (
          <div className={`${PANEL_CLASS}__unavailable`}>
            {t("roster.unavailable")}
          </div>
        ) : view.kind === "empty" ? (
          <div className={`${PANEL_CLASS}__empty`}>{t("roster.empty")}</div>
        ) : (
          <ul className={`${PANEL_CLASS}__list`}>
            {view.rows.map((row) => (
              <li
                key={row.workerId}
                className={`${PANEL_CLASS}__row`}
                data-status={row.statusLabel}
              >
                <span className={`${PANEL_CLASS}__row-title`}>{row.title}</span>
                <span className={`${PANEL_CLASS}__row-status`}>
                  {row.statusLabel}
                </span>
                {row.todoId !== null ? (
                  <span className={`${PANEL_CLASS}__row-todo`}>
                    {row.todoId}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };
}
