/**
 * Onboarding first-run pane (ticket 68, ADR-0018 in-scope area).
 *
 * An IN-SHELL surface: the shell HOSTS this pane in its no-selection main
 * seat (`shell.tsx` `ShellHosts.onboarding`), so the flow survives the
 * ticket-78 cutover — it lives in our frame, never in the staging-only
 * shipped `settings.onboarding` slot (the triage brief's cutover-proof rule).
 *
 * What renders is the PURE view model (`describeOnboardingPane` in
 * `onboarding.ts`, offline-tested):
 * - settled (suppressed, or the flow completed) → the shell's own
 *   no-selection copy, one vocabulary — plus the one honest save-failed line
 *   when the Done/Skip flag write did not land (retry-less, U-A: no retry
 *   control; the flow simply shows again next launch — fail-open);
 * - pending (ticket 87: the suppression read is in flight) → the SAME calm
 *   no-selection state, never the flow and never a fake suppression — the
 *   decision renders only once the document lands or the read settles
 *   unreadable (fail-open show, as always);
 * - beats → the current beat's title + body, step count, progress dots,
 *   Skip, and Next/Get-started. No animations anywhere; the beat walk is a
 *   plain re-render.
 *
 * Buttons are the only interactivity: Skip and the last beat's Get-started
 * complete the flow and hand the seen WRITE to the composition (`onSeen` —
 * the composition owns the ONE bound settings scope; this component never
 * touches a service). A resolved write is silent — the watch re-delivers the
 * document and the suppression decision closes the pane (no fake success
 * surface, the same discipline as the capsule's actions).
 *
 * Styles ship as a plain string in a <style> element (same discipline as the
 * shell/panel/capsule): every class is `multitask-dispatcher-` prefixed,
 * every colour resolves through an evidenced `--dsw-alias-*` token
 * (ticket 49's contract), text hierarchy is opacity-based, no text colour is
 * set, and there is no animation at all.
 */
import { useSyncExternalStore } from "react";
import type { JSX } from "react";
import type { TranslateFn } from "./overlay.js";
import { formatTemplate } from "./roster-store.js";
import {
  ONBOARDING_BEATS,
  describeOnboardingPane,
  type OnboardingStore,
} from "./onboarding.js";
import type { DispatcherShellStore } from "./shell-store.js";

/** Class prefix — ours, namespaced, no shipped kit classes. */
export const ONBOARDING_CLASS = "multitask-dispatcher-onboarding";

/**
 * Onboarding styles (ticket 68, themed per ticket 49). Colours referenced:
 * `--dsw-alias-bg-layer-1/3` (surfaces — layer-3 is the host's own floating-
 * surface value), `--dsw-alias-border-l3`, `--dsw-alias-label-tertiary`, and
 * the `state-*` roles (`business` for the active progress dot and the
 * primary action's border, `warn` for the save-failed line) — the same
 * evidenced vocabulary the shell and launcher use.
 */
export const ONBOARDING_CSS = `
.multitask-dispatcher-onboarding{display:flex;flex-direction:column;gap:10px;margin:auto;max-width:460px;padding:16px;border-radius:10px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);font-size:13px;line-height:1.5}
.multitask-dispatcher-onboarding__title{margin:0;font-weight:600}
.multitask-dispatcher-onboarding__body{margin:0;opacity:.75}
.multitask-dispatcher-onboarding__meta{display:flex;align-items:center;gap:8px;opacity:.6;font-size:11px}
.multitask-dispatcher-onboarding__dots{display:flex;gap:4px}
.multitask-dispatcher-onboarding__dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.multitask-dispatcher-onboarding__dot[data-active="true"]{background:var(--dsw-alias-state-business-primary)}
.multitask-dispatcher-onboarding__actions{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:2px}
.multitask-dispatcher-onboarding__button{padding:4px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:inherit;font:inherit;cursor:pointer}
.multitask-dispatcher-onboarding__button:hover{border-color:var(--dsw-alias-label-tertiary)}
.multitask-dispatcher-onboarding__button[data-primary="true"]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-1)}
.multitask-dispatcher-onboarding__settled{margin:auto;max-width:460px;padding:16px;opacity:.6;text-align:center}
.multitask-dispatcher-onboarding__save-failed{margin:0 0 8px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary);opacity:.8}
`;

/**
 * Create the onboarding pane bound to the translate seat, the onboarding
 * store (beat walk + seen input), the shell store (the dispatcher mirrors —
 * the "≥1 dispatcher session" suppression input), and the composition's
 * seen-write hand-off. Zero-prop function component; slot entries may hand
 * renderer-controlled props, which this component deliberately ignores.
 */
export function createOnboardingPane(
  t: TranslateFn,
  store: OnboardingStore,
  shell: DispatcherShellStore,
  actions: { readonly onSeen: () => void },
): () => JSX.Element {
  return () => {
    const box = useSyncExternalStore(store.subscribe, store.getBox);
    // The dispatcher mirrors are suppression input #2; subscribing keeps the
    // pane honest when a session activates while the flow is open.
    const shellBox = useSyncExternalStore(shell.subscribe, shell.getBox);

    const view = describeOnboardingPane(box, shellBox.state.mirrors);
    const complete = (): void => {
      store.complete();
      actions.onSeen();
    };

    return (
      <div
        className={ONBOARDING_CLASS}
        data-onboarding={view.kind}
        data-beat={view.kind === "beats" ? view.beatId : undefined}
      >
        <style>{ONBOARDING_CSS}</style>
        {view.kind === "beats" ? (
          <>
            <h2 className={`${ONBOARDING_CLASS}__title`}>{t(view.titleKey)}</h2>
            <p className={`${ONBOARDING_CLASS}__body`}>{t(view.bodyKey)}</p>
            <div className={`${ONBOARDING_CLASS}__meta`}>
              <span className={`${ONBOARDING_CLASS}__dots`} aria-hidden="true">
                {ONBOARDING_BEATS.map((entry, index) => (
                  <span
                    key={entry.id}
                    className={`${ONBOARDING_CLASS}__dot`}
                    data-active={
                      index === view.activeDot ? "true" : "false"
                    }
                  />
                ))}
              </span>
              <span>
                {formatTemplate(t("shell.onboard.step"), {
                  current: String(view.stepCurrent),
                  total: String(view.stepTotal),
                })}
              </span>
            </div>
            <div className={`${ONBOARDING_CLASS}__actions`}>
              <button
                type="button"
                className={`${ONBOARDING_CLASS}__button`}
                onClick={complete}
              >
                {t("shell.onboard.skip")}
              </button>
              <button
                type="button"
                className={`${ONBOARDING_CLASS}__button`}
                data-primary="true"
                onClick={view.isLast ? complete : () => store.advance()}
              >
                {t(view.isLast ? "shell.onboard.done" : "shell.onboard.next")}
              </button>
            </div>
          </>
        ) : (
          // Settled, or pending (ticket 87): the shell's calm no-selection
          // copy either way — a pending read renders no flow and no
          // save-failed line (nothing was attempted yet).
          <div className={`${ONBOARDING_CLASS}__settled-wrap`}>
            {view.kind === "settled" && view.saveFailed ? (
              <p className={`${ONBOARDING_CLASS}__save-failed`}>
                {t("shell.onboard.save-failed")}
              </p>
            ) : null}
            <div className={`${ONBOARDING_CLASS}__settled`}>
              {t("shell.noselection")}
            </div>
          </div>
        )}
      </div>
    );
  };
}
