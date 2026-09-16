/**
 * Hello-world placeholder panel (ticket 20).
 *
 * The scaffold stays inert by design (design-16 §5 "never registered" list):
 * the panel renders only labeled placeholder copy from the plugin's locale
 * namespace. No shipped slot keys, no shadowing elections, no data plumbing —
 * roster/status surfaces are tickets 21/24.
 *
 * The component is a zero-prop function component created through a factory
 * so the translate seat is captured at registration time; slot entries may be
 * handed renderer-controlled props, which this scaffold deliberately ignores.
 */
import type { JSX } from "react";

/** Bound translate seat (`ctx.locale.bind(namespace)`). */
export type TranslateFn = (key: string) => string;

/** Class prefix — ours, namespaced, no shipped kit classes. */
const PANEL_CLASS = "multitask-dispatcher-hello-panel";

/** Create the placeholder panel component bound to a translate seat. */
export function createHelloPanel(t: TranslateFn): () => JSX.Element {
  return () => (
    <div className={PANEL_CLASS}>
      <div className={`${PANEL_CLASS}__title`}>{t("panel.title")}</div>
      <div className={`${PANEL_CLASS}__placeholder`}>
        {t("panel.placeholder")}
      </div>
    </div>
  );
}
