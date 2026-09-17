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
 * renders the existing panel component unchanged (ticket-28 sections); the
 * activation row, action wiring, deliverables line, and footer are later
 * sub-tickets (39–42) and deliberately absent.
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
 * chip view model and the expansion store are asserted purely in
 * `test/client-capsule-chip.test.ts`.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { JSX } from "react";
import {
  CAPSULE_CHIP_OPEN_KEY,
  CAPSULE_CHIP_WAKE_KEY,
  CAPSULE_CHIP_WORKERS_KEY,
  CAPSULE_COLLAPSE_KEY,
  CAPSULE_DOT_KEYS,
  describeCapsuleChip,
  type CapsuleStore,
} from "./capsule-store.js";
import { createRosterPanel } from "./panel.js";
import {
  ROSTER_STALE_RECHECK_MS,
  formatTemplate,
  type RosterStore,
} from "./roster-store.js";
import type { TranslateFn } from "./overlay.js";

/** Class prefix — ours, namespaced, no shipped kit classes. */
const CAPSULE_CLASS = "multitask-dispatcher-capsule";

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
`;

/**
 * Create the capsule component bound to a translate seat, the roster data
 * store, and the capsule's own expansion store. The existing panel component
 * is created once here and rendered unchanged when expanded.
 */
export function createDispatcherCapsule(
  t: TranslateFn,
  store: RosterStore,
  capsule: CapsuleStore,
): () => JSX.Element {
  const Panel = createRosterPanel(t, store);
  return () => {
    const box = useSyncExternalStore(store.subscribe, store.getBox);
    const expansion = useSyncExternalStore(capsule.subscribe, capsule.getBox);
    const chip = describeCapsuleChip(box.state, Date.now());

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
            {/* The existing panel, unchanged this ticket (ticket-28
                sections; activation row/actions/footer are tickets 39–42). */}
            <Panel />
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
