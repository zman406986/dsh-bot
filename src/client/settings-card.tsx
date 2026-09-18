/**
 * The `Settings → 插件配置` card component (ticket 47).
 *
 * One plugin card inside the shipped configurable-plugins tab: a header naming
 * the plugin and what its settings govern, disclosing its controls in place,
 * with the save that writes them. The tab renders us inside a `<ul>`, so the
 * card is an `<li>` — the same shape the shipped cards render
 * (`dsh-client-ui-settings-plugins/lib/client.js:201-275`).
 *
 * Presentation + staging only: nothing here writes as a control settles. A
 * control reports what the user typed to the store; the card's Save is the one
 * point where a draft becomes a document mutation (the shipped form contract,
 * `card-form.d.ts`). The component owns exactly one local state — whether the
 * card is open — because which card a user has open is a reading gesture.
 *
 * Availability is the store's verdict, not this component's: while the
 * namespace is not served the card renders NOTHING (the shipped `PluginCard`
 * behaviour), so a deployment that does not compose the plugin leaves no trace.
 *
 * Theming (ticket 49's contract): every colour is a host design token
 * (`--dsw-alias-*`, ordinary custom properties on `body` — see `capsule.tsx`),
 * and the control vocabulary deliberately matches the shipped card CSS: the
 * card is `bg-layer-3` with a `border-l4` hairline, an open card drops to
 * `bg-layer-2`, text walks label-primary → secondary → tertiary, and the save
 * button is the inverted `label-primary` fill. The focus ring is
 * `state-business-primary` (the shipped tab's own choice), NOT `brand-primary`.
 *
 * One shipped trap deliberately NOT copied: that package's failure line paints
 * `var(--dsw-alias-label-error)`, a token **defined nowhere** in
 * `dsh-client-ui-theme` — the reference is dead and the text inherits. We use
 * the defined `--dsw-alias-state-error-primary`.
 *
 * Rendering is covered by build + typecheck only (S8: no DOM harness); the
 * registration, the form model, and this stylesheet's token contract are
 * asserted offline in `test/client-settings-card.test.ts` and
 * `test/client-theme-tokens.test.ts`.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import {
  SETTINGS_CARD_COLLAPSE_KEY,
  SETTINGS_CARD_DESCRIPTION_KEY,
  SETTINGS_CARD_DISCARD_KEY,
  SETTINGS_CARD_EXPAND_KEY,
  SETTINGS_CARD_FAILED_KEY,
  SETTINGS_CARD_INVALID_KEY,
  SETTINGS_CARD_OVERRIDDEN_KEY,
  SETTINGS_CARD_READONLY_KEY,
  SETTINGS_CARD_RESET_KEY,
  SETTINGS_CARD_SAVE_KEY,
  SETTINGS_CARD_TITLE_KEY,
  SETTINGS_CARD_UNSAVED_KEY,
  type SettingsCardFieldBox,
  type SettingsCardStore,
} from "./settings-card-store.js";
import type { TranslateFn } from "./overlay.js";

/** Class prefix — ours, namespaced, no shipped kit classes. */
const CARD_CLASS = "multitask-dispatcher-settings-card";

/**
 * Card styles. Roles are the shipped card's, expressed in the shared token
 * layer: `bg-layer-3` for the resting card, `bg-layer-2` once open, a
 * `border-l4` hairline that lifts to `label-dimmed` on hover, dividers on
 * `border-l2`, and the save button as the inverted `label-primary` fill.
 */
export const SETTINGS_CARD_CSS = `
.${CARD_CLASS}{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;color:var(--dsw-alias-label-primary);font-size:13px;transition:border-color .16s,background .16s}
.${CARD_CLASS}:hover{border-color:var(--dsw-alias-label-dimmed)}
.${CARD_CLASS}[data-open="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.${CARD_CLASS}__header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:none;border:0;border-radius:12px;display:flex;align-items:center;gap:12px;padding:14px 16px}
.${CARD_CLASS}__header:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.${CARD_CLASS}__head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.${CARD_CLASS}__name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.${CARD_CLASS}__description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.${CARD_CLASS}__unsaved{flex:none;font-size:11px;padding:1px 7px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.${CARD_CLASS}__chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}
.${CARD_CLASS}[data-open="true"] .${CARD_CLASS}__chevron{transform:rotate(180deg)}
.${CARD_CLASS}__body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.${CARD_CLASS}__read-only{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}
.${CARD_CLASS}__field{margin-top:14px}
.${CARD_CLASS}__field-head{display:flex;align-items:center;gap:8px}
.${CARD_CLASS}__label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}
.${CARD_CLASS}__overridden{font-size:11px;padding:1px 7px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.${CARD_CLASS}__reset{margin-left:auto;appearance:none;border:1px solid transparent;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;padding:1px 6px;border-radius:6px;cursor:pointer}
.${CARD_CLASS}__reset:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.${CARD_CLASS}__control{display:flex;align-items:center;gap:8px;margin-top:6px}
.${CARD_CLASS}__checkbox{flex:none;width:14px;height:14px;accent-color:var(--dsw-alias-state-business-primary)}
.${CARD_CLASS}__input{width:100%;box-sizing:border-box;font:inherit;font-size:13px;padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.${CARD_CLASS}__input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.${CARD_CLASS}__hint{margin:5px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.${CARD_CLASS}__hint[data-invalid="true"]{color:var(--dsw-alias-state-error-primary)}
.${CARD_CLASS}__footer{border-top:.5px solid var(--dsw-alias-border-l2);display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px}
.${CARD_CLASS}__failed{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
.${CARD_CLASS}__discard,.${CARD_CLASS}__save{appearance:none;font:inherit;font-size:13px;line-height:1.5;padding:5px 14px;border-radius:8px;border:1px solid transparent;cursor:pointer}
.${CARD_CLASS}__discard{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}
.${CARD_CLASS}__discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.${CARD_CLASS}__save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.${CARD_CLASS}__discard:focus-visible,.${CARD_CLASS}__save:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.${CARD_CLASS}__discard:disabled,.${CARD_CLASS}__save:disabled,.${CARD_CLASS}__reset:disabled,.${CARD_CLASS}__input:disabled,.${CARD_CLASS}__checkbox:disabled{opacity:.4;cursor:default}
`;

/**
 * One disclosure chevron. Inline SVG rather than a shipped icon: the icon
 * primitives are not a cordis service and not a dependency we declare, and a
 * glyph is the smaller, cleaner step. `currentColor` keeps it on the label
 * token through the CSS above.
 */
function Chevron(): JSX.Element {
  return (
    <svg
      className={`${CARD_CLASS}__chevron`}
      width="12"
      height="12"
      viewBox="0,0,12,12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2.5,4.5L6,8L9.5,4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * One field control. A `boolean` field is a checkbox (its staged drafts are
 * only ever "true"/"false"; a clear is staged by the reset control, and an
 * unreadable value renders indeterminate rather than asserting `false`). A
 * `number` field is a numeric input with the draft as its value. Both are
 * disabled while the document is read-only or a save is in flight.
 */
function FieldControl(props: {
  t: TranslateFn;
  box: SettingsCardFieldBox;
  disabled: boolean;
  onEdit: (text: string) => void;
  onReset: () => void;
}): JSX.Element {
  const { t, box, disabled, onEdit, onReset } = props;
  const id = `${CARD_CLASS}-field-${box.field}`;
  const inputRef = useRef<HTMLInputElement>(null);

  // `checked` null means nothing readable backs the box: an indeterminate
  // checkbox states exactly that, where `false` would be a fabricated value.
  useEffect(() => {
    if (inputRef.current !== null) {
      inputRef.current.indeterminate = box.checked === null;
    }
  }, [box.checked]);

  return (
    <div className={`${CARD_CLASS}__field`}>
      <div className={`${CARD_CLASS}__field-head`}>
        <label className={`${CARD_CLASS}__label`} htmlFor={id}>
          {t(box.labelKey)}
        </label>
        {box.overridden ? (
          <span className={`${CARD_CLASS}__overridden`}>
            {t(SETTINGS_CARD_OVERRIDDEN_KEY)}
          </span>
        ) : null}
        {box.overridden ? (
          <button
            type="button"
            className={`${CARD_CLASS}__reset`}
            disabled={disabled}
            onClick={onReset}
          >
            {t(SETTINGS_CARD_RESET_KEY)}
          </button>
        ) : null}
      </div>
      <div className={`${CARD_CLASS}__control`}>
        {box.kind === "boolean" ? (
          <input
            id={id}
            ref={inputRef}
            type="checkbox"
            className={`${CARD_CLASS}__checkbox`}
            checked={box.checked === true}
            disabled={disabled}
            onChange={(event) => onEdit(event.target.checked ? "true" : "false")}
          />
        ) : (
          <input
            id={id}
            type="number"
            inputMode="numeric"
            className={`${CARD_CLASS}__input`}
            value={box.text}
            disabled={disabled}
            onChange={(event) => onEdit(event.target.value)}
          />
        )}
      </div>
      {/* The invalid copy REPLACES the hint rather than sitting beside it: one
          line explains the control, and a rejected draft is the more urgent
          thing to say about it. */}
      <p
        className={`${CARD_CLASS}__hint`}
        data-invalid={box.invalid ? "true" : "false"}
      >
        {box.invalid ? t(SETTINGS_CARD_INVALID_KEY) : t(box.hintKey)}
      </p>
    </div>
  );
}

/**
 * Create the settings card component bound to a translate seat and the card
 * store (factory injection, the same pattern as the capsule). Renders nothing
 * while the store reports the namespace unavailable — no error surface, no
 * disabled control.
 */
export function createPluginSettingsCard(
  t: TranslateFn,
  store: SettingsCardStore,
): () => JSX.Element | null {
  return () => {
    const box = useSyncExternalStore(store.subscribe, store.getBox);
    const [open, setOpen] = useState(false);
    const { view } = box;

    if (!view.available) return null;

    const disabled = !view.writable || box.saving;
    return (
      <li className={CARD_CLASS} data-open={open ? "true" : "false"}>
        <style>{SETTINGS_CARD_CSS}</style>
        <button
          type="button"
          className={`${CARD_CLASS}__header`}
          aria-expanded={open}
          aria-label={`${t(open ? SETTINGS_CARD_COLLAPSE_KEY : SETTINGS_CARD_EXPAND_KEY)}: ${t(SETTINGS_CARD_TITLE_KEY)}`}
          onClick={() => setOpen(!open)}
        >
          <span className={`${CARD_CLASS}__head-text`}>
            <span className={`${CARD_CLASS}__name`}>
              {t(SETTINGS_CARD_TITLE_KEY)}
            </span>
            <span className={`${CARD_CLASS}__description`}>
              {t(SETTINGS_CARD_DESCRIPTION_KEY)}
            </span>
          </span>
          {box.dirty ? (
            <span className={`${CARD_CLASS}__unsaved`}>
              {t(SETTINGS_CARD_UNSAVED_KEY)}
            </span>
          ) : null}
          <Chevron />
        </button>
        {open ? (
          <div className={`${CARD_CLASS}__body`}>
            {!view.writable ? (
              <p className={`${CARD_CLASS}__read-only`} role="status">
                {t(SETTINGS_CARD_READONLY_KEY)}
              </p>
            ) : null}
            {view.fields.map((field) => (
              <FieldControl
                key={field.field}
                t={t}
                box={field}
                disabled={disabled}
                onEdit={(text) => store.edit(field.field, text)}
                onReset={() => store.reset(field.field)}
              />
            ))}
            <div className={`${CARD_CLASS}__footer`}>
              {box.failed ? (
                <p className={`${CARD_CLASS}__failed`} role="status">
                  {t(SETTINGS_CARD_FAILED_KEY)}
                </p>
              ) : null}
              <button
                type="button"
                className={`${CARD_CLASS}__discard`}
                disabled={!box.dirty || box.saving}
                onClick={store.discard}
              >
                {t(SETTINGS_CARD_DISCARD_KEY)}
              </button>
              <button
                type="button"
                className={`${CARD_CLASS}__save`}
                disabled={!box.dirty || !view.valid || disabled}
                onClick={() => void store.save()}
              >
                {t(SETTINGS_CARD_SAVE_KEY)}
              </button>
            </div>
          </div>
        ) : null}
      </li>
    );
  };
}
