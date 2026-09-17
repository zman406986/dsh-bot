/**
 * The dispatcher capsule (ticket 38, ADR-0013): the ONE additive
 * `shell.overlay` entry, now a collapsed chip that expands into the existing
 * panel — not a second entry, no new slot (the registration options in
 * `overlay.ts` are untouched).
 *
 * Presentation only, same discipline as `panel.tsx`: the capsule never
 * spawns, steers, or stops anything. The chip is the glanceable presence
 * projection — activation dot (`dormant`/`active`/`error` from the chip view
 * model in `capsule-store.ts`), worker count, wake badge — and expanding
 * renders the ticket-39 activation row over the ticket-28 sections:
 *
 * - **dormant** (`waiting`) — the activation pitch IS the panel: state line,
 *   pitch body, one start affordance; roster sections hidden;
 * - **activated** (fresh snapshot) — the active state line plus a stop
 *   INTENT affordance, and the existing panel sections below;
 * - **unavailable** (stale/invalid/channel-missing) — the honest degraded
 *   line, no start/stop affordance, no sections.
 *
 * The affordances call the injected `onActivationIntent` callback (factory
 * injection, same pattern as the translate seat) through
 * `dispatchActivationIntent` — the callback is an INTENT seat, not a
 * control: no direct stop/deactivate authority exists on this surface
 * (ADR-0005/0009; ticket 31's guard). The default seat is a no-op, so the
 * capsule stays render-only; ticket 40 binds the callback to the verified
 * user-verbatim command path. The deliverables line and footer are later
 * sub-tickets (41–42) and deliberately absent.
 *
 * Expansion state is the entry's OWN state (ADR-0013 — the host offers no
 * expansion/anchoring API): the `CapsuleStore` created with the module fiber.
 * The chip is a real `<button>` (keyboard-reachable expand), the card carries
 * a collapse control; both are labeled through the locale seat — no literal
 * copy.
 *
 * Self-positioning: the overlay layer is a frame-wide `pointer-events:none`
 * absolute surface whose direct children opt back in, and the slot outlet's
 * `display:contents` anchor inherits pointer events to this whole subtree
 * (`docs/research/dsh-capsule-seams.md`, seam 1). The entry therefore
 * positions itself (top-right of the frame) and blocks only where it draws —
 * there is no backdrop, so everything outside the chip/card stays
 * click-through.
 *
 * Rendering is covered by build + typecheck only (S8: no DOM harness); the
 * chip/activation view models and the intent dispatch are asserted purely in
 * `test/client-capsule-chip.test.ts` and
 * `test/client-capsule-activation.test.ts`.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { JSX } from "react";
import {
  CAPSULE_ACTIVATION_PITCH_KEY,
  CAPSULE_CHIP_OPEN_KEY,
  CAPSULE_CHIP_WAKE_KEY,
  CAPSULE_CHIP_WORKERS_KEY,
  CAPSULE_COLLAPSE_KEY,
  CAPSULE_DOT_KEYS,
  describeCapsuleActivationRow,
  describeCapsuleChip,
  dispatchActivationIntent,
  noopOnActivationIntent,
  type CapsuleStore,
  type OnActivationIntent,
} from "./capsule-store.js";
import {
  type CapsuleActionStatus,
  type CapsuleActionStatusBox,
  type SteerPrefillOutcome,
} from "./actions.js";
import { createRosterPanel } from "./panel.js";
import {
  ROSTER_STALE_RECHECK_MS,
  formatTemplate,
  type RosterStore,
} from "./roster-store.js";
import type { TranslateFn } from "./overlay.js";

/** Class prefix — ours, namespaced, no shipped kit classes. */
const CAPSULE_CLASS = "multitask-dispatcher-capsule";

/** Idle status substitutes so the hooks stay unconditional (stable fns). */
const noopSubscribe = () => () => {};
const IDLE_STATUS_BOX: CapsuleActionStatusBox = { copyKey: null, version: 0 };
const noopStatusBox = (): CapsuleActionStatusBox => IDLE_STATUS_BOX;

/**
 * Capsule styles (ticket 38). The chip/card float top-right over the frame;
 * colors match the panel palette so no theme contract is assumed. No
 * animation — the skeleton is static (the only animation in the client face
 * remains the panel's running ring).
 */
export const CAPSULE_CSS = `
.${CAPSULE_CLASS}{position:absolute;top:8px;right:8px;font-size:12px;line-height:1.5}
.${CAPSULE_CLASS}__chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:12px;border:1px solid #30363d;background:#161b22;color:#c9d1d9;cursor:pointer;font:inherit}
.${CAPSULE_CLASS}__dot{flex:none;width:8px;height:8px;border-radius:50%;background:#8b949e}
.${CAPSULE_CLASS}__dot[data-dot="active"]{background:#2f81f7}
.${CAPSULE_CLASS}__dot[data-dot="error"]{background:#f85149}
.${CAPSULE_CLASS}__count{opacity:.75}
.${CAPSULE_CLASS}__wake{padding:0 6px;border-radius:8px;border:1px solid currentColor;color:#2ea043}
.${CAPSULE_CLASS}__card{width:320px;max-width:calc(100vw - 16px);max-height:60vh;overflow:auto;padding:10px;border:1px solid #30363d;border-radius:8px;background:#161b22;color:#c9d1d9;box-shadow:0 8px 24px rgba(0,0,0,.4)}
.${CAPSULE_CLASS}__card-bar{display:flex;justify-content:flex-end;margin-bottom:6px}
.${CAPSULE_CLASS}__collapse{border:none;background:transparent;color:inherit;opacity:.6;cursor:pointer;font:inherit;font-size:11px;padding:0}
.${CAPSULE_CLASS}__collapse:hover{opacity:1}
.${CAPSULE_CLASS}__activation{display:flex;flex-direction:column;gap:8px}
.${CAPSULE_CLASS}__activation[data-composition="activated"]{margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #30363d}
.${CAPSULE_CLASS}__activation-state{font-weight:600}
.${CAPSULE_CLASS}__activation-pitch{opacity:.7}
.${CAPSULE_CLASS}__activation-button{align-self:flex-start;padding:3px 10px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:inherit;cursor:pointer;font:inherit}
.${CAPSULE_CLASS}__activation-button:hover{border-color:#8b949e}
.${CAPSULE_CLASS}__action-notice{opacity:.85;color:#f85149;font-size:11px}
`;

/**
 * Create the capsule component bound to a translate seat, the roster data
 * store, the capsule's own expansion store, and the ticket-40 action seats
 * (factory injection, same pattern as the translate seat):
 *
 * - `onActivationIntent` — ticket 39's intent seat; `index.ts` binds it to
 *   the verified command/prompt transports via `actions.ts`;
 * - `actionStatus` — the honest notice line for failed sends (no success
 *   state exists to flip to); `undefined` keeps the capsule render-only;
 * - `onRowSteer` — the per-row steer prefill seat handed to the panel.
 *
 * The default intent seat is a no-op: without a binding the capsule renders
 * and dispatches into the void.
 */
export function createDispatcherCapsule(
  t: TranslateFn,
  store: RosterStore,
  capsule: CapsuleStore,
  onActivationIntent: OnActivationIntent = noopOnActivationIntent,
  actionStatus?: CapsuleActionStatus,
  onRowSteer?: (workerId: string) => SteerPrefillOutcome,
): () => JSX.Element {
  const Panel = createRosterPanel(t, store, onRowSteer);
  return () => {
    const box = useSyncExternalStore(store.subscribe, store.getBox);
    const expansion = useSyncExternalStore(capsule.subscribe, capsule.getBox);
    const actionBox = useSyncExternalStore(
      actionStatus?.subscribe ?? noopSubscribe,
      actionStatus?.getBox ?? noopStatusBox,
    );
    const now = Date.now();
    const chip = describeCapsuleChip(box.state, now);
    const activation = describeCapsuleActivationRow(box.state, now);
    const affordance = activation.affordance;

    // Same honesty rule as the panel: the mirror channel has no heartbeat,
    // so re-evaluate staleness on a slow tick (a fresh snapshot must age
    // into the error dot without a push). React lifecycle only — never
    // armed by the offline tests.
    useEffect(() => {
      const handle = setInterval(store.refresh, ROSTER_STALE_RECHECK_MS);
      return () => clearInterval(handle);
    }, [store]);

    if (expansion.expanded) {
      return (
        <div className={CAPSULE_CLASS} data-expanded="true">
          <style>{CAPSULE_CSS}</style>
          <div className={`${CAPSULE_CLASS}__card`}>
            <div className={`${CAPSULE_CLASS}__card-bar`}>
              <button
                type="button"
                className={`${CAPSULE_CLASS}__collapse`}
                onClick={capsule.collapse}
              >
                {t(CAPSULE_COLLAPSE_KEY)}
              </button>
            </div>
            {/* Ticket-39 activation row: exactly one composition per store
                kind. The affordance is an INTENT seat — dispatch hands the
                payload to the injected callback and nothing else; no direct
                stop/deactivate authority exists here (ticket 31's guard). */}
            <div
              className={`${CAPSULE_CLASS}__activation`}
              data-composition={activation.composition}
            >
              <div className={`${CAPSULE_CLASS}__activation-state`}>
                {t(activation.stateKey)}
              </div>
              {activation.composition === "dormant" ? (
                <div className={`${CAPSULE_CLASS}__activation-pitch`}>
                  {t(CAPSULE_ACTIVATION_PITCH_KEY)}
                </div>
              ) : null}
              {affordance !== null ? (
                <button
                  type="button"
                  className={`${CAPSULE_CLASS}__activation-button`}
                  data-intent={affordance.intent}
                  onClick={() =>
                    dispatchActivationIntent(affordance, onActivationIntent)
                  }
                >
                  {t(affordance.labelKey)}
                </button>
              ) : null}
              {/* Ticket 40: the honest notice line — error copy from the
                  last send attempt only. There is deliberately no success
                  notice: acceptance is silent, and the roster feed (or the
                  dispatcher's conversational confirm) is the only success
                  truth. Never flips any state to "success". */}
              {actionBox.copyKey !== null ? (
                <div className={`${CAPSULE_CLASS}__action-notice`}>
                  {t(actionBox.copyKey)}
                </div>
              ) : null}
            </div>
            {/* Sections only in the activated composition: dormant hides them
                (the pitch IS the whole panel — ticket 32's dormant face), and
                a degraded channel has no honest rows to show, so the row's
                unavailable line is the whole story. */}
            {activation.composition === "activated" ? <Panel /> : null}
          </div>
        </div>
      );
    }

    return (
      <div className={CAPSULE_CLASS} data-expanded="false">
        <style>{CAPSULE_CSS}</style>
        <button
          type="button"
          className={`${CAPSULE_CLASS}__chip`}
          data-dot={chip.dot}
          aria-label={t(CAPSULE_CHIP_OPEN_KEY)}
          onClick={capsule.expand}
        >
          {/* The activation dot: state keyed in `data-dot`, labeled for
              screen readers through the per-state locale key. */}
          <span
            className={`${CAPSULE_CLASS}__dot`}
            data-dot={chip.dot}
            role="img"
            aria-label={t(CAPSULE_DOT_KEYS[chip.dot])}
          />
          {chip.workerCount !== null ? (
            <span className={`${CAPSULE_CLASS}__count`}>
              {formatTemplate(t(CAPSULE_CHIP_WORKERS_KEY), {
                count: String(chip.workerCount),
              })}
            </span>
          ) : null}
          {chip.wakeCount !== null && chip.wakeCount > 0 ? (
            <span className={`${CAPSULE_CLASS}__wake`}>
              {formatTemplate(t(CAPSULE_CHIP_WAKE_KEY), {
                count: String(chip.wakeCount),
              })}
            </span>
          ) : null}
        </button>
      </div>
    );
  };
}
