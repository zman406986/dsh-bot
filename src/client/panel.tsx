/**
 * Roster/status panel (tickets 21 + 27), replacing ticket 20's hello
 * placeholder.
 *
 * Presentation only: the panel never spawns, steers, or stops anything — all
 * authority stays with the bound parent agent via the core (design-16 §3.4).
 * Ticket 40 adds the epic's per-row steer affordance, which stays inside
 * that rule: it only PREFILLS the user's own composer draft (verified seam,
 * `actions.ts`) — the send, and the host-side `/dispatcher-steer` transport
 * into the core last-wins queue, remain the user's and the host's.
 * It renders the store's view model: title, the three ticket-28 sections
 * (Active / Needs you / Finished, design-17 §4.2), and within them one row
 * per worker carrying the design-17 §4.1 presence picture (status dot,
 * animated ring only while running/steering, landed marker, derived
 * activity line, muted ledger linkage), plus the
 * empty state, the loading state, or the honest "unavailable" state — never
 * a spinner that hangs. Delivered terminal rows collapse into a muted count
 * line within Finished; the count comes from the view model, so the
 * component only localizes it.
 *
 * The Needs-you section is the honest pull-only stand-in for push attention
 * (no push seam exists; design-17 §4.8) — see `roster-store.ts` for the
 * partition rule. This component does no precedence logic of its own.
 *
 * The component is a zero-prop function component created through a factory so
 * the translate seat and the data store are captured at registration time;
 * slot entries may be handed renderer-controlled props, which this panel
 * deliberately ignores. Rendering itself is covered by build + typecheck only
 * (S8: no DOM harness); the view model is asserted purely in tests.
 *
 * Styles ship as a plain string rendered into a <style> element by the
 * component itself: every class and keyframe name is `multitask-dispatcher-`
 * prefixed (no shipped kit classes, no build-toolchain change), the only
 * animation is the running ring, and it turns off under
 * `prefers-reduced-motion`. The element mounts and unmounts with the panel,
 * so an HMR fiber swap removes it with everything else.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import {
  FACT_SEPARATOR,
  ROSTER_FINISHED_COUNT_KEY,
  ROSTER_STALE_RECHECK_MS,
  describeRosterPanel,
  formatCount,
  formatTemplate,
  type RosterRowView,
  type RosterSectionView,
  type RosterStore,
} from "./roster-store.js";
import {
  ROSTER_STEER_BUTTON_KEY,
  ROSTER_STEER_COPY_FALLBACK_KEY,
  ROSTER_STEER_HINT_KEY,
  type SteerPrefillOutcome,
} from "./actions.js";

/** Bound translate seat (`ctx.locale.bind(namespace)`), re-exported. */
export type { TranslateFn } from "./overlay.js";
import type { TranslateFn } from "./overlay.js";

/** Class prefix — ours, namespaced, no shipped kit classes. */
const PANEL_CLASS = "multitask-dispatcher-roster-panel";

/**
 * Panel styles (tickets 27 + 28, themed by ticket 49). Presentation only — no
 * layout promises beyond this panel's own subtree. Every colour is a host
 * design token (`--dsw-alias-*`), inherited from the shell's theme stylesheet
 * (`dsh-client-ui-theme/lib/client.js:1052-1060`); status dots use the
 * `state-*` family, and the working ring keeps its translucency through
 * `color-mix` — the same idiom the host's own stylesheets use over tokens.
 * Text hierarchy and type sizes are deliberately left opacity-based / px.
 */
export const ROSTER_PANEL_CSS = `
.multitask-dispatcher-roster-panel{font-size:12px;line-height:1.5;min-width:0}
.multitask-dispatcher-roster-panel__title{font-weight:600;margin-bottom:6px}
.multitask-dispatcher-roster-panel__unavailable,
.multitask-dispatcher-roster-panel__empty,
.multitask-dispatcher-roster-panel__loading{opacity:.7}
.multitask-dispatcher-roster-panel__sections{display:flex;flex-direction:column;gap:12px}
.multitask-dispatcher-roster-panel__section-title{font-weight:600;opacity:.75;margin-bottom:4px}
.multitask-dispatcher-roster-panel__list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.multitask-dispatcher-roster-panel__row{display:flex;align-items:flex-start;gap:8px;min-width:0}
.multitask-dispatcher-roster-panel__row[data-finished="true"] .multitask-dispatcher-roster-panel__row-title,
.multitask-dispatcher-roster-panel__row[data-finished="true"] .multitask-dispatcher-roster-panel__row-status{opacity:.6}
.multitask-dispatcher-roster-panel__dot{flex:none;position:relative;width:8px;height:8px;margin-top:4px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.multitask-dispatcher-roster-panel__dot[data-visual="working"]{background:var(--dsw-alias-state-business-primary)}
.multitask-dispatcher-roster-panel__dot[data-visual="starting"]{background:var(--dsw-alias-state-warn-primary)}
.multitask-dispatcher-roster-panel__dot[data-visual="done"]{background:var(--dsw-alias-state-success-primary)}
.multitask-dispatcher-roster-panel__dot[data-visual="failed"]{background:var(--dsw-alias-state-error-primary)}
.multitask-dispatcher-roster-panel__dot[data-visual="stopped"]{background:var(--dsw-alias-label-tertiary)}
.multitask-dispatcher-roster-panel__dot[data-visual="working"]::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);animation:multitask-dispatcher-roster-ring 1.6s ease-out infinite}
@keyframes multitask-dispatcher-roster-ring{0%{transform:scale(.6);opacity:.9}100%{transform:scale(1.5);opacity:0}}
@media (prefers-reduced-motion: reduce){.multitask-dispatcher-roster-panel__dot[data-visual="working"]::after{animation:none;transform:none;opacity:.35}}
.multitask-dispatcher-roster-panel__row-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.multitask-dispatcher-roster-panel__row-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.multitask-dispatcher-roster-panel__row-status{opacity:.75}
.multitask-dispatcher-roster-panel__row-activity{opacity:.55}
.multitask-dispatcher-roster-panel__row-marker{align-self:flex-start;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 6px;border-radius:8px;border:1px solid currentColor}
.multitask-dispatcher-roster-panel__row-marker--landed{color:var(--dsw-alias-state-success-primary)}
.multitask-dispatcher-roster-panel__row-steer{display:flex;align-items:center;gap:6px;margin-top:2px;flex-wrap:wrap}
.multitask-dispatcher-roster-panel__steer{align-self:flex-start;padding:1px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:inherit;opacity:.75;cursor:pointer;font:inherit;font-size:11px}
.multitask-dispatcher-roster-panel__steer:hover{opacity:1;border-color:var(--dsw-alias-label-tertiary)}
.multitask-dispatcher-roster-panel__steer-hint{opacity:.6;font-size:11px;min-width:0}
.multitask-dispatcher-roster-panel__finished-count{opacity:.5;font-size:11px}
.multitask-dispatcher-roster-panel__finished-count > summary{opacity:1;cursor:default}
`;

/**
 * The facts line: `{elapsed} · {n} tool calls · started {time}`. Zero tool
 * calls are omitted, and the raw status never repeats here (it has its own
 * localized word).
 */
function factsLine(t: TranslateFn, row: RosterRowView): string {
  const facts = [row.elapsedText];
  if (row.toolCallCount > 0) {
    facts.push(
      formatCount(t, "roster.activity.toolcalls", row.toolCallCount),
    );
  }
  facts.push(
    formatTemplate(t("roster.fact.started"), { time: row.startText }),
  );
  return facts.join(FACT_SEPARATOR);
}

/**
 * One roster row (tickets 27 + 28; steer affordance ticket 40). `collapsed`
 * lives on the view model, so the component only decides *where* a row
 * renders, never *whether* it belongs (the partition rule is asserted in
 * the store's offline tests).
 *
 * The per-row steer affordance (non-finished rows only — steering a
 * settled worker is refused host-side, so offering it would be a lie) is a
 * prefill seat, not a transport: clicking calls the injected
 * `onRowSteer(workerId)` which writes `/dispatcher-steer <workerId> ` into
 * the composer draft (verified seam, focus not exposed) and the row pairs
 * the result with the honest hint, or with the copy-only fallback when the
 * draft is unreachable. The row never sends anything.
 */
function RosterRow(props: {
  t: TranslateFn;
  row: RosterRowView;
  onSteer?: ((workerId: string) => SteerPrefillOutcome) | undefined;
}): JSX.Element {
  const { t, row, onSteer } = props;
  const [steerCopyKey, setSteerCopyKey] = useState<string | null>(null);
  return (
    <li
      className={`${PANEL_CLASS}__row`}
      data-status={row.statusLabel}
      data-visual={row.visual}
      data-marker={row.marker?.kind ?? ""}
      data-section={row.section}
      data-finished={row.finished ? "true" : "false"}
      data-worker-id={row.workerId}
      data-todo-id={row.todoId ?? undefined}
      data-start={row.startText}
      data-tool-calls={String(row.toolCallCount)}
    >
      {/* Status dot / running ring: `data-status` keys the verbatim
          core vocabulary; the ring animates only for working rows. */}
      <span
        className={`${PANEL_CLASS}__dot`}
        data-status={row.statusLabel}
        data-visual={row.visual}
        aria-hidden="true"
      />
      <span className={`${PANEL_CLASS}__row-body`}>
        <span className={`${PANEL_CLASS}__row-title`}>{row.title}</span>
        {row.marker?.kind === "landed" ? (
          <span
            className={`${PANEL_CLASS}__row-marker ${PANEL_CLASS}__row-marker--landed`}
          >
            {t("roster.landed")}
          </span>
        ) : null}
        <span className={`${PANEL_CLASS}__row-status`}>
          {t(row.statusWordKey)}
        </span>
        <span className={`${PANEL_CLASS}__row-activity`}>
          {factsLine(t, row)}
        </span>
        {onSteer !== undefined && row.finished === false ? (
          <span className={`${PANEL_CLASS}__row-steer`}>
            <button
              type="button"
              className={`${PANEL_CLASS}__steer`}
              data-worker={row.workerId}
              onClick={() => {
                const outcome = onSteer(row.workerId);
                setSteerCopyKey(
                  outcome.kind === "prefilled"
                    ? ROSTER_STEER_HINT_KEY
                    : ROSTER_STEER_COPY_FALLBACK_KEY,
                );
              }}
            >
              {t(ROSTER_STEER_BUTTON_KEY)}
            </button>
            {steerCopyKey !== null ? (
              <span className={`${PANEL_CLASS}__steer-hint`}>
                {formatTemplate(t(steerCopyKey), { worker: row.workerId })}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/**
 * One section. Empty sections render nothing (no dangling heading); the
 * Finished section's collapsed rows hide behind a native `<details>`, so the
 * "count line that expands" needs no state and no imperative handler.
 */
function rosterSection(
  t: TranslateFn,
  section: RosterSectionView,
  onSteer?: (workerId: string) => SteerPrefillOutcome,
): JSX.Element | null {
  const visible = section.rows.filter((row) => !row.collapsed);
  const collapsed = section.rows.filter((row) => row.collapsed);
  if (visible.length === 0 && collapsed.length === 0) return null;
  const list = (rows: readonly RosterRowView[]) =>
    rows.length === 0 ? null : (
      <ul className={`${PANEL_CLASS}__list`}>
        {rows.map((row) => (
          <RosterRow key={row.workerId} t={t} row={row} onSteer={onSteer} />
        ))}
      </ul>
    );
  return (
    <div
      key={section.id}
      className={`${PANEL_CLASS}__section`}
      data-section={section.id}
    >
      <div className={`${PANEL_CLASS}__section-title`}>
        {t(section.titleKey)}
      </div>
      {list(visible)}
      {collapsed.length > 0 ? (
        <details className={`${PANEL_CLASS}__finished-count`}>
          <summary>
            {formatCount(t, ROSTER_FINISHED_COUNT_KEY, collapsed.length)}
          </summary>
          {list(collapsed)}
        </details>
      ) : null}
    </div>
  );
}

/**
 * Create the roster panel component bound to a translate seat and store.
 * `onSteer` (ticket 40) is the optional per-row steer prefill seat — a
 * pure `(workerId) => outcome` function over the verified composer-draft
 * seam; without it the rows render without the affordance (same
 * render-only default discipline as the capsule's intent seat).
 */
export function createRosterPanel(
  t: TranslateFn,
  store: RosterStore,
  onSteer?: (workerId: string) => SteerPrefillOutcome,
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
        <style>{ROSTER_PANEL_CSS}</style>
        <div className={`${PANEL_CLASS}__title`}>{t("roster.title")}</div>
        {view.kind === "unavailable" ? (
          <div className={`${PANEL_CLASS}__unavailable`}>
            {t("roster.unavailable")}
          </div>
        ) : view.kind === "loading" ? (
          <div className={`${PANEL_CLASS}__loading`}>{t("roster.loading")}</div>
        ) : view.kind === "empty" ? (
          <div className={`${PANEL_CLASS}__empty`}>{t("roster.empty")}</div>
        ) : (
          <div className={`${PANEL_CLASS}__sections`}>
            {view.sections.map((section) => rosterSection(t, section, onSteer))}
          </div>
        )}
      </div>
    );
  };
}
