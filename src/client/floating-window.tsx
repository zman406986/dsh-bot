/**
 * Floating dispatcher window + the stock-UI launcher chip (ticket 100,
 * ADR-0021).
 *
 * VEHICLE. The launcher chip is THE one additive `shell.overlay` entry
 * (ADR-0013's sanctioned seam; the retired capsule's slot, a fresh id). The
 * chip toggles the floating window, which HOSTS the existing
 * `createDispatcherShell` tree — re-hosted surface inventory, never a
 * rebuild (ADR-0021 decisions 2 and 4) and never a capsule revival (the
 * whole shell, not a collapsed chip; the chip itself is launch affordance
 * ONLY — no presence counters; those stay in the sidebar rows inside the
 * window).
 *
 * DOM TECHNIQUE — React portal (decided on this ticket's evidence, per
 * ADR-0021's open question): the window renders through `createPortal`
 * into a module-owned container appended to `document.body`, NOT as a
 * second overlay entry. Evidence:
 * - The overlay seam has no geometry/anchor/positioning API — "entries are
 *   plain React roots inside a frame-wide absolute layer … position and
 *   size themselves with their own DOM" (`docs/research/dsh-capsule-seams.md`
 *   Seam 1 / Finding 5). A viewport-anchored window that must stack ABOVE
 *   every sibling entry is brittle inside that layer's stacking context
 *   (DOM order among entries decides); a body-level container escapes the
 *   app frame's stacking and containing contexts entirely.
 * - A second, always-registered overlay entry was REJECTED: the recorded
 *   seam posture is ONE entry per product surface (ADR-0013), and a
 *   register/unregister-per-toggle would churn host registry lifecycle
 *   operations for what is view state.
 * - Theme survives the portal: the `--dsw-alias-*` tokens are defined on
 *   `body`, so "every descendant inherits them"
 *   (`docs/research/dsh-plugin-ui-patterns.md` Finding 5, ticket 49 note) —
 *   the body-level container is a body descendant, and every colour below
 *   resolves through a token (the ticket-49 contract; no private palette).
 * - `react-dom` is a platform seed word the module loader's `require`
 *   resolves (`src/client/wrapper.ts`, ticket 20 Finding 4) — no new host
 *   seam is invented by the portal import.
 *
 * CRASH ISOLATION (ADR-0021 decision 2, re-based from the retired root
 * abdication onto the additive posture) — two recorded layers:
 * - Host layer (evidence, no code): EVERY slot entry renders inside dsh's
 *   per-entry `SlotErrorBoundary` ("one registrant crashing … must not
 *   take down siblings", ui-renderer `lib/client.js:511-532`), and for a
 *   `list` slot a crash reports with `abdicate: true`, retiring only the
 *   crashing entry (`docs/research/dsh-capsule-seams.md` Seam 1). Stock dsh
 *   was never shadowed, so ANY crash of our entry leaves the app standing.
 * - Our layer (stricter than the host's): the ticket requires that the
 *   LAUNCHER CHIP survive a crash of the window's shell tree. A portal
 *   keeps the window in the chip entry's React subtree, so an uncaught
 *   crash there would retire the WHOLE entry at the host layer — chip
 *   included. {@link DispatcherWindowBoundary} therefore wraps the hosted
 *   shell INSIDE the window, below the portal: a shell crash renders the
 *   honest failed line in the window body while the titlebar (drag +
 *   close) and the chip are untouched. A fresh boundary mounts per open
 *   (keyed by the store's `openEpoch`), so close + reopen recovers.
 *
 * Presentation only: positioning/drag/close state lives in
 * `floating-window-store.ts` (in-memory only — no persistence is claimed);
 * this component maps store state to DOM and feeds pointer deltas back.
 * Styles are the shell discipline: `multitask-dispatcher-` prefixed
 * classes, every colour a host `--dsw-alias-*` token, opacity-based
 * hierarchy, no animation, no text colour (the host theme's inherits).
 */
import { Component, useSyncExternalStore, createElement } from "react";
import type { JSX, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type {
  FloatingWindowState,
  FloatingWindowStore,
} from "./floating-window-store.js";
import { FALLBACK_VIEWPORT } from "./floating-window-store.js";

/** Class prefix — ours, namespaced, no shipped kit classes. */
export const FLOATING_WINDOW_CLASS = "multitask-dispatcher-fwin";

/**
 * Window + chip styles (ticket 100, themed per ticket 49). Colours:
 * `--dsw-alias-bg-layer-1/3` (the host's own floating-surface value for
 * layer-3), `--dsw-alias-border-l3`. The `z-index` is a plain integer —
 * the body-level container must stand above the app frame; the tokens
 * govern colours, not stacking. The chip rides the overlay layer's
 * click-through contract: the entry subtree inherits pointer events
 * through the outlet's `display:contents` anchor (dsh-capsule-seams.md
 * Seam 1), so the chip is interactive and draws nothing where it is not.
 */
export const FLOATING_WINDOW_CSS = `
.multitask-dispatcher-fwin-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);font-size:12px;font-weight:600;opacity:.85;cursor:pointer;color:inherit;font-family:inherit}
.multitask-dispatcher-fwin-chip:hover{opacity:1}
.multitask-dispatcher-fwin-chip[aria-pressed="true"]{border-color:var(--dsw-alias-state-business-primary)}
.multitask-dispatcher-fwin{position:fixed;z-index:1000;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3);border-radius:10px;overflow:hidden;font-size:13px;line-height:1.5;font-family:inherit;color:inherit}
.multitask-dispatcher-fwin__titlebar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px 6px 12px;background:var(--dsw-alias-bg-layer-3);border-bottom:1px solid var(--dsw-alias-border-l3);cursor:move;user-select:none;touch-action:none}
.multitask-dispatcher-fwin__title{font-weight:600;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.multitask-dispatcher-fwin__close{flex:none;border:none;background:transparent;color:inherit;font:inherit;font-size:14px;opacity:.6;cursor:pointer;padding:0 6px}
.multitask-dispatcher-fwin__close:hover{opacity:.95}
.multitask-dispatcher-fwin__body{flex:1;min-height:0}
.multitask-dispatcher-fwin__failed{padding:14px;opacity:.7}
`;

/** Resolved chrome copy for the window + chip (one vocabulary, see keys). */
export interface FloatingWindowChrome {
  /** Window titlebar title — the shared `shell.title` face. */
  readonly title: string;
  /** Close button's accessible label/title — `launcher.window.close`. */
  readonly close: string;
  /** The isolation boundary's honest failed line — `launcher.window.failed`. */
  readonly failed: string;
}

/**
 * Resolve the chrome copy from a translate seat (the composition's single
 * `t` bind; keys documented at `localeDictionary`).
 */
export function floatingWindowChrome(t: (key: string) => string): FloatingWindowChrome {
  return {
    title: t("shell.title"),
    close: t("launcher.window.close"),
    failed: t("launcher.window.failed"),
  };
}

/**
 * The window's crash-isolation boundary (ticket 100; ADR-0021 decision 2).
 * A class component because React error boundaries are lifecycle, not
 * hooks. `render()` is hook-free and deterministic from state, so offline
 * tests can drive the static mapping and both render branches directly
 * (S8); the jsdom suite drives the real path with a throwing child.
 */
export class DispatcherWindowBoundary extends Component<
  { readonly failed: string; readonly children: JSX.Element },
  { readonly failed: boolean }
> {
  constructor(props: { readonly failed: string; readonly children: JSX.Element }) {
    super(props);
    this.state = { failed: false };
  }

  /** React's boundary contract: a child render crash flips to the fallback. */
  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  /** Contained by design — the honest fallback line below IS the report. */
  componentDidCatch(_error: unknown, _info: unknown): void {}

  override render(): JSX.Element {
    if (this.state.failed) {
      return (
        <div className={`${FLOATING_WINDOW_CLASS}__failed`} data-window="failed">
          {this.props.failed}
        </div>
      );
    }
    return this.props.children;
  }
}

/** The drag/close handlers the pure tree builder attaches. */
export interface FloatingWindowActions {
  readonly onClose: () => void;
  readonly onTitlebarPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

/**
 * The window's element tree, as a PURE function of the store state (no
 * hooks — the hooked component below subscribes and delegates here, the
 * same "pure describe + thin component" split as the shell). The isolation
 * boundary sits in the BODY only: the titlebar (drag + close) renders
 * outside it, so a crashed shell never takes the window chrome — or the
 * chip, or stock dsh — down with it. The boundary is keyed by the store's
 * `openEpoch`, so every open mounts a fresh boundary (a crashed window
 * recovers on reopen).
 */
export function describeFloatingWindow(
  state: FloatingWindowState,
  chrome: FloatingWindowChrome,
  actions: FloatingWindowActions,
  content: JSX.Element,
  openEpoch: number,
): JSX.Element {
  return (
    <div
      className={FLOATING_WINDOW_CLASS}
      data-window="dispatcher"
      style={{
        left: state.x,
        top: state.y,
        width: state.width,
        height: state.height,
      }}
    >
      <style>{FLOATING_WINDOW_CSS}</style>
      <div
        className={`${FLOATING_WINDOW_CLASS}__titlebar`}
        data-window-drag-handle="true"
        onPointerDown={actions.onTitlebarPointerDown}
      >
        <span className={`${FLOATING_WINDOW_CLASS}__title`}>{chrome.title}</span>
        <button
          type="button"
          className={`${FLOATING_WINDOW_CLASS}__close`}
          aria-label={chrome.close}
          title={chrome.close}
          onClick={actions.onClose}
        >
          ×
        </button>
      </div>
      <div className={`${FLOATING_WINDOW_CLASS}__body`}>
        <DispatcherWindowBoundary key={openEpoch} failed={chrome.failed}>
          {content}
        </DispatcherWindowBoundary>
      </div>
    </div>
  );
}

/**
 * The module-owned portal container: one div appended to `document.body`
 * (never inside the host app frame — see the technique note above). Created
 * lazily on first render; `typeof document === "undefined"` (offline node)
 * yields null and the window simply does not render. The composition
 * registers {@link disposeWindowLayer} on its fiber so unload/HMR removes
 * the container with the module.
 */
let layer: HTMLDivElement | null = null;

export function windowLayer(): HTMLDivElement | null {
  if (typeof document === "undefined") return null;
  if (layer === null || !layer.isConnected) {
    layer = document.createElement("div");
    layer.className = `${FLOATING_WINDOW_CLASS}-layer`;
    document.body.appendChild(layer);
  }
  return layer;
}

/** Fiber teardown for the portal container (HMR-safe; offline no-op). */
export function disposeWindowLayer(): void {
  if (layer !== null) {
    layer.remove();
    layer = null;
  }
}

/** The live viewport for clamping (the store itself never reads `window`). */
function liveViewport(): { width: number; height: number } {
  if (typeof window === "undefined") return FALLBACK_VIEWPORT;
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Drag: titlebar pointerdown seeds the last-seen point and rides window
 * pointermove deltas into `store.moveBy` (clamped there) until pointerup
 * or pointercancel. Listeners live on `window` so a fast drag that leaves
 * the titlebar never strands. Each move applies only its OWN delta,
 * measured against the previous move rather than the drag start, so the
 * delta lands exactly once and no start-relative offset accumulates.
 * Between clamp events the window tracks the pointer exactly. When the
 * clamp absorbs part of a move (the position has hit a viewport bound)
 * `moveBy` lands on the clamped edge, or early-returns when the position
 * is already there, so the window keeps that clamped position and slips
 * out of phase with the pointer by the absorbed amount; the slip is
 * bounded and never compounds, and the next move measures from the
 * pointer's own last point and continues from the clamped position.
 */
function beginDrag(
  event: ReactPointerEvent<HTMLDivElement>,
  store: FloatingWindowStore,
): void {
  if (event.button !== 0) return;
  let lastX = event.clientX;
  let lastY = event.clientY;
  const onMove = (move: PointerEvent) => {
    const dx = move.clientX - lastX;
    const dy = move.clientY - lastY;
    lastX = move.clientX;
    lastY = move.clientY;
    store.moveBy(dx, dy, liveViewport());
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

/**
 * The floating window surface: subscribes to the window store and, while
 * open, portals {@link describeFloatingWindow} — hosting `content` (the
 * re-hosted `createDispatcherShell` element tree) behind the isolation
 * boundary — into the module's body-level layer. Closed (or offline, no
 * layer): renders nothing. The boundary key is the store's `openEpoch`, so
 * every open mounts a FRESH boundary and a previously crashed window
 * recovers on reopen.
 */
export function createFloatingWindow(
  t: (key: string) => string,
  store: FloatingWindowStore,
  content: JSX.Element,
): () => JSX.Element | null {
  const chrome = floatingWindowChrome(t);
  return () => {
    const box = useSyncExternalStore(store.subscribe, store.getBox);
    const target = windowLayer();
    if (!box.state.open || target === null) return null;
    return createPortal(
      describeFloatingWindow(
        box.state,
        chrome,
        {
          onClose: () => store.close(),
          onTitlebarPointerDown: (event) => beginDrag(event, store),
        },
        content,
        box.state.openEpoch,
      ),
      target,
    );
  };
}

/**
 * The launcher chip (THE one `shell.overlay` entry, ticket 100): a small
 * toggler for the floating window — launch affordance ONLY (no presence
 * counters; the cancelled capsule's info model stays retired). Renders the
 * chip button and the window surface beside it (the surface portals itself
 * out of the overlay layer at body level).
 */
export function createLauncherChip(
  t: (key: string) => string,
  store: FloatingWindowStore,
  content: JSX.Element,
): () => JSX.Element {
  const Window = createFloatingWindow(t, store, content);
  return () => {
    const box = useSyncExternalStore(store.subscribe, store.getBox);
    return (
      <>
        <button
          type="button"
          className={`${FLOATING_WINDOW_CLASS}-chip`}
          data-launcher="dispatcher"
          aria-pressed={box.state.open}
          onClick={() => store.toggle(liveViewport())}
        >
          {t("launcher.chip.label")}
        </button>
        {createElement(Window)}
      </>
    );
  };
}
