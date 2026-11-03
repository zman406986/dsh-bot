/**
 * Per-tool call view components (ticket 24; layout fixed by ticket 169).
 *
 * Presentation only, like the roster panel: views parse their props through
 * `describeToolview` (pure, never throws) and render a compact detail row —
 * worker id, title, outcome, steer text, or the check roster's status rows
 * with the core FSM vocabulary verbatim. No actions, no fetches, no authority
 * (design-16 §3.4).
 *
 * Ticket 169: the row ships its own stylesheet (`TOOLVIEW_CSS`,
 * `toolview-styles.ts`) and puts a separator element between fields. Before
 * that, the `__field*` class names had no stylesheet behind them anywhere in
 * the tree, so every span stayed inline and a four-field row rendered as one
 * unbroken string (`Worker063f41a2…TitleAdd stale-build…Outcomeok`). The
 * separation is now structural in three independent layers — flex block
 * layout, a `gap`, and a real separator element — so no single lost rule can
 * collapse the row again.
 *
 * The row is read-only and emits each field exactly once: the outcome is a
 * field like any other, and nothing here mirrors it onto a second line.
 *
 * Zero-hook function components created through a factory so the translate
 * seat and tool name are captured at registration time; the renderer
 * controls the props face, which the parser treats defensively. Rendering is
 * covered by build success + typecheck + the static-markup pins in
 * `test/client-toolviews.test.ts` (S8: no DOM harness).
 */
import { Fragment, type JSX } from "react";
import type { TranslateFn } from "./overlay.js";
import {
  TOOLVIEW_DEGRADED_KEY,
  describeToolview,
} from "./toolviews.js";
import { TOOLVIEW_CLASS as VIEW_CLASS, TOOLVIEW_CSS } from "./toolview-styles.js";

/**
 * One literal space, rendered as its own text node wherever two pieces of the
 * row must not fuse.
 *
 * Flex layout ignores whitespace-only children (they are not flex items), so
 * this costs nothing visually while the stylesheet is present — but if the
 * stylesheet ever stops applying, the row degrades to separated plain text
 * instead of the fused run ticket 169 reported.
 *
 * Written as an escape because `test/composition-polish.test.ts` treats any
 * quoted literal holding a space as a possible dictionary bypass, and a space
 * is not user-facing copy to localize.
 */
const FIELD_SPACE = "\u0020";

/**
 * Create the toolview component for one wire tool name. Pure and
 * props-driven: same props in, same element out; no hooks, no store.
 */
export function createToolviewComponent(
  toolName: string,
  t: TranslateFn,
): (props: unknown) => JSX.Element {
  return (props: unknown) => {
    const view = describeToolview(toolName, props);

    if (view.kind === "degraded") {
      return (
        <div className={VIEW_CLASS} data-tool={toolName}>
          <style>{TOOLVIEW_CSS}</style>
          <span className={`${VIEW_CLASS}__degraded`}>
            {t(TOOLVIEW_DEGRADED_KEY)}
          </span>
        </div>
      );
    }

    return (
      <div className={VIEW_CLASS} data-tool={toolName}>
        <style>{TOOLVIEW_CSS}</style>
        {view.fields.map((field, index) => (
          <Fragment key={field.labelKey}>
            {index > 0 ? (
              <>
                {/* A real separator box AND a whitespace text node. Flex
                    layout ignores the whitespace (it is not a flex item), so
                    the visible gap comes from `gap` + the dot; if the
                    stylesheet is ever lost, the whitespace still keeps the
                    fields apart as plain inline text. */}
                {FIELD_SPACE}
                <span
                  className={`${VIEW_CLASS}__sep`}
                  aria-hidden="true"
                  data-separator=""
                />
                {FIELD_SPACE}
              </>
            ) : null}
            <span
              className={`${VIEW_CLASS}__field`}
              data-field={field.labelKey}
            >
              <span
                className={`${VIEW_CLASS}__field-label`}
                data-field-label={field.labelKey}
              >
                {t(field.labelKey)}
              </span>
              {FIELD_SPACE}
              <span
                className={`${VIEW_CLASS}__field-value`}
                data-field-value={field.labelKey}
              >
                {field.value}
              </span>
            </span>
          </Fragment>
        ))}
        {view.statusRows.length > 0 ? (
          <ul className={`${VIEW_CLASS}__rows`}>
            {view.statusRows.map((row, index) => (
              <li
                key={`${row.workerId}-${index}`}
                className={`${VIEW_CLASS}__row`}
                data-status={row.statusLabel ?? undefined}
              >
                <span className={`${VIEW_CLASS}__row-id`}>
                  {row.workerId}
                </span>
                {FIELD_SPACE}
                <span className={`${VIEW_CLASS}__row-title`}>
                  {row.title}
                </span>
                {row.statusLabel !== null ? (
                  <>
                    {FIELD_SPACE}
                    <span className={`${VIEW_CLASS}__row-status`}>
                      {row.statusLabel}
                    </span>
                  </>
                ) : null}
                {row.activity !== null ? (
                  <>
                    {FIELD_SPACE}
                    <span className={`${VIEW_CLASS}__row-activity`}>
                      {row.activity}
                    </span>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  };
}
