/**
 * Floating dispatcher window — placement store (ticket 100, ADR-0021).
 *
 * Pure state + placement decisions for the floating window that hosts the
 * dispatcher shell: open/close (the launcher chip toggles it), the window's
 * position, and the drag clamp. In-memory ONLY — no persistence is claimed:
 * a reload starts closed at the default placement again (honest; the store
 * records no storage of any kind).
 *
 * All geometry is decided here, not in the component (same discipline as
 * `shell-store.ts`'s `describe*` decisions): the component maps store state
 * to styles and feeds pointer deltas into {@link FloatingWindowStore.moveBy};
 * every clamp is a pure function pinned offline. State is replaced
 * immutably and published through a stable box, the exact
 * `useSyncExternalStore` shape the shell/panel/conversation stores use.
 *
 * Placement rules (pinned offline):
 * - Default placement is a {@link FLOATING_WINDOW_MARGIN} offset from the
 *   viewport's top-right corner — out of the stock chat's reading column.
 * - Dragging clamps the window's top-left so at least
 *   {@link FLOATING_WINDOW_MIN_PEEK} pixels of it stay inside the viewport
 *   on each axis: the titlebar can always be grabbed again, and the window
 *   can never be dragged wholly off-screen (and lost).
 * - A viewport smaller than the peek margin pins the window at the
 *   viewport's right/bottom edge deterministically (the bounds collapse to
 *   that edge; never a NaN, never a throw).
 *
 * Resize + maximize rules (ticket 105, pinned offline):
 * - `resizeBy` grows/shrinks the window from the dragged face: east/south
 *   faces keep the top-left corner put; west/north faces keep the OPPOSITE
 *   edge put (x/y adjust, the size compensates), then the position runs
 *   through the same clamp as a drag (position validity wins if the two
 *   ever disagree). Size clamps to the {@link FLOATING_WINDOW_MIN_WIDTH}/
 *   {@link FLOATING_WINDOW_MIN_HEIGHT} minimum and to the viewport (a face
 *   never crosses a viewport edge). An absorbed delta emits nothing — the
 *   exact `moveBy` early-return contract.
 * - `toggleMaximize` fills the viewport minus {@link FLOATING_WINDOW_MARGIN}
 *   on every side and remembers the prior rect; the second toggle restores
 *   that rect exactly, re-clamped in POSITION against the given viewport
 *   (the remembered size is exact even if the viewport shrank while
 *   maximized — the peek clamp keeps the titlebar reachable). While
 *   maximized, `moveBy` RESTORES FIRST and then applies the delta (the
 *   Windows-like drag-restore rule), and `resizeBy` is a no-op (grab the
 *   titlebar or the button to leave maximize). A maximized window stays
 *   maximized across close/reopen — reopen re-fills the CURRENT viewport;
 *   the remembered rect survives until restore.
 */

/** The viewport the clamp math works against (width/height in px). */
export interface WindowViewport {
  readonly width: number;
  readonly height: number;
}

/** One published snapshot of the window's placement state. */
export interface FloatingWindowState {
  /** The window renders only while open; the launcher chip toggles this. */
  readonly open: boolean;
  /**
   * Increments on every transition into `open` (not on close): the window
   * component keys the shell's isolation boundary by this, so closing and
   * reopening mounts a FRESH boundary — a crashed window recovers on
   * reopen instead of showing its failed line forever.
   */
  readonly openEpoch: number;
  /** Top-left position (px, viewport coordinates; clamped by `moveBy`). */
  readonly x: number;
  readonly y: number;
  /**
   * The window's size (px) — mutated through `resizeBy`/`toggleMaximize`
   * (ticket 105), clamped to the minimum size and to the viewport. Still
   * in-memory only: a reload starts at the default size again.
   */
  readonly width: number;
  readonly height: number;
  /**
   * True while the window fills the viewport minus the margin
   * (`toggleMaximize`); the pre-maximize rect lives in the store until
   * restore (ticket 105).
   */
  readonly maximized: boolean;
}

/** The store face the chip and the window component bind through. */
export interface FloatingWindowBox {
  readonly state: FloatingWindowState;
  readonly version: number;
}

export interface FloatingWindowStore {
  subscribe(listener: () => void): () => void;
  getBox(): FloatingWindowBox;
  /**
   * Open the window. The FIRST open places it at the default top-right
   * placement for the given viewport (fallback viewport when absent —
   * offline/off-screen callers); later opens REOPEN WHERE IT WAS (the last
   * position is kept, re-clamped against the given viewport). Opening an
   * open window is a no-op (the epoch does not move).
   */
  open(viewport?: WindowViewport): void;
  /** Hide the window; the position is retained for the next open. */
  close(): void;
  /** The launcher chip's verb: close when open, open when closed. */
  toggle(viewport?: WindowViewport): void;
  /**
   * Drag: move by a pointer delta, clamped so the window stays reachable.
   * A no-op while closed (nothing visible to move). While maximized this
   * RESTORES first (the Windows-like drag-restore rule, ticket 105) and
   * then applies the delta to the restored rect.
   */
  moveBy(dx: number, dy: number, viewport: WindowViewport): void;
  /**
   * Resize from a dragged face (ticket 105): `dx`/`dy` are the pointer's
   * per-event delta (the drag pattern — each move feeds its OWN delta) and
   * `edge` says which face the pointer drags. East/south faces keep the
   * top-left corner put; west/north faces keep the opposite edge put, then
   * the position runs through the drag clamp. Size clamps to the minimum
   * and to the viewport; an absorbed delta emits nothing (the `moveBy`
   * contract). A no-op while closed or while maximized.
   */
  resizeBy(
    edge: FloatingWindowResizeEdge,
    dx: number,
    dy: number,
    viewport: WindowViewport,
  ): void;
  /**
   * Windows-style maximize/restore toggle (ticket 105): maximize fills the
   * viewport minus {@link FLOATING_WINDOW_MARGIN} on every side and
   * remembers the prior rect; restore returns that rect exactly (position
   * re-clamped against the given viewport). Rejected while closed.
   */
  toggleMaximize(viewport: WindowViewport): void;
}

/** The window's default size (px) — fits the shell's three panes comfortably. */
export const FLOATING_WINDOW_WIDTH = 760;
export const FLOATING_WINDOW_HEIGHT = 520;

/**
 * The smallest resizable size (px, ticket 105): small enough to stay usable
 * on a crowded viewport, large enough that the titlebar and the shell's
 * panes keep working. `resizeBy` never goes below either axis, and the
 * maximize fill clamps to them on absurdly small viewports.
 */
export const FLOATING_WINDOW_MIN_WIDTH = 320;
export const FLOATING_WINDOW_MIN_HEIGHT = 240;

/**
 * Which face(s) a resize drags (ticket 105): compass edges, corners
 * combining two. The store math supports all eight; the window component
 * wires the clean subset (the north faces would steal the titlebar's drag
 * strip and the buttons — see `floating-window.tsx`).
 */
export type FloatingWindowResizeEdge =
  | "n"
  | "s"
  | "e"
  | "w"
  | "ne"
  | "nw"
  | "se"
  | "sw";

/**
 * The default placement's offset from the viewport's top-right corner (px).
 */
export const FLOATING_WINDOW_MARGIN = 24;

/**
 * How much of the window must remain inside the viewport on each axis
 * (px): the minimum grabbable strip. Dragging cannot push less than this
 * of the window off-screen, so the titlebar is always reachable again.
 */
export const FLOATING_WINDOW_MIN_PEEK = 64;

/**
 * The viewport assumed when a caller cannot supply one (the store must
 * stay pure — it never reads `window` itself). Placement placed against
 * this is re-clamped on the first real drag with the live viewport.
 */
export const FALLBACK_VIEWPORT: WindowViewport = { width: 1280, height: 800 };

/**
 * The default placement: a margin offset from the viewport's top-right
 * corner, then run through the same clamp as a drag (one visibility rule,
 * never two).
 */
export function defaultWindowPlacement(
  state: Pick<FloatingWindowState, "width" | "height">,
  viewport: WindowViewport,
): { x: number; y: number } {
  return clampWindowPosition(
    viewport.width - state.width - FLOATING_WINDOW_MARGIN,
    FLOATING_WINDOW_MARGIN,
    state.width,
    state.height,
    viewport,
  );
}

/**
 * Clamp a top-left position so at least {@link FLOATING_WINDOW_MIN_PEEK} px
 * of the window stays inside the viewport on each axis. When the viewport
 * is smaller than the peek margin the axis bounds collapse to that edge
 * (the window pins at the right/bottom edge) — deterministic, never NaN.
 */
export function clampWindowPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewport: WindowViewport,
): { x: number; y: number } {
  const peek = FLOATING_WINDOW_MIN_PEEK;
  const minX = peek - width;
  const maxX = Math.max(minX, viewport.width - peek);
  const minY = 0;
  const maxY = Math.max(minY, viewport.height - peek);
  return {
    x: Math.min(maxX, Math.max(minX, x)),
    y: Math.min(maxY, Math.max(minY, y)),
  };
}

/** `Math.min(hi, Math.max(lo, v))` under a name (resize/maximize clamps). */
function clampScalar(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * The maximized rect (ticket 105): the viewport minus
 * {@link FLOATING_WINDOW_MARGIN} on every side, clamped to the minimum
 * size (a viewport smaller than the fill pins at the minimum) and run
 * through the position clamp like every other placement — one visibility
 * rule, never two. Pure; pinned offline.
 */
export function maximizedWindowPlacement(viewport: WindowViewport): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const width = Math.max(
    FLOATING_WINDOW_MIN_WIDTH,
    viewport.width - 2 * FLOATING_WINDOW_MARGIN,
  );
  const height = Math.max(
    FLOATING_WINDOW_MIN_HEIGHT,
    viewport.height - 2 * FLOATING_WINDOW_MARGIN,
  );
  const placed = clampWindowPosition(
    FLOATING_WINDOW_MARGIN,
    FLOATING_WINDOW_MARGIN,
    width,
    height,
    viewport,
  );
  return { x: placed.x, y: placed.y, width, height };
}

/** Whether two states carry the same rendered geometry (no emit needed). */
function sameWindowGeometry(
  a: Pick<FloatingWindowState, "x" | "y" | "width" | "height" | "maximized">,
  b: Pick<FloatingWindowState, "x" | "y" | "width" | "height" | "maximized">,
): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.maximized === b.maximized
  );
}

export function createFloatingWindowStore(): FloatingWindowStore {
  let state: FloatingWindowState = {
    open: false,
    openEpoch: 0,
    x: 0,
    y: 0,
    width: FLOATING_WINDOW_WIDTH,
    height: FLOATING_WINDOW_HEIGHT,
    maximized: false,
  };
  // The pre-maximize rect (ticket 105): render-invisible bookkeeping, so it
  // lives in the closure rather than the published state. It survives
  // close/reopen (a maximized window reopens maximized) until restore.
  let preMaximize: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null = null;
  let version = 0;
  let box: FloatingWindowBox = { state, version };
  const listeners = new Set<() => void>();

  function emit(next: FloatingWindowState): void {
    state = next;
    version += 1;
    box = { state, version };
    for (const listener of [...listeners]) listener();
  }

  /** The state after leaving maximize: remembered rect, position re-clamped. */
  function restoredState(viewport: WindowViewport): FloatingWindowState {
    const remembered = preMaximize ?? {
      x: state.x,
      y: state.y,
      width: state.width,
      height: state.height,
    };
    const placed = clampWindowPosition(
      remembered.x,
      remembered.y,
      remembered.width,
      remembered.height,
      viewport,
    );
    return {
      ...state,
      maximized: false,
      x: placed.x,
      y: placed.y,
      width: remembered.width,
      height: remembered.height,
    };
  }

  function open(viewport?: WindowViewport): void {
    if (state.open) return;
    const vp = viewport ?? FALLBACK_VIEWPORT;
    const firstOpen = state.openEpoch === 0;
    let rect: { x: number; y: number; width: number; height: number };
    if (!firstOpen && state.maximized) {
      // A maximized window reopens maximized — re-filled against the
      // CURRENT viewport (the fill is re-clamped, never stale).
      rect = maximizedWindowPlacement(vp);
    } else {
      const placed = firstOpen
        ? defaultWindowPlacement(state, vp)
        : // Reopen where it was — re-clamped against the live viewport.
          clampWindowPosition(state.x, state.y, state.width, state.height, vp);
      rect = {
        x: placed.x,
        y: placed.y,
        width: state.width,
        height: state.height,
      };
    }
    emit({
      ...state,
      open: true,
      openEpoch: state.openEpoch + 1,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }

  function close(): void {
    if (!state.open) return;
    emit({ ...state, open: false });
  }

  return {
    getBox() {
      return box;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open,
    close,
    toggle(viewport) {
      if (state.open) close();
      else open(viewport);
    },
    moveBy(dx, dy, viewport) {
      if (!state.open) return;
      if (state.maximized) {
        // Windows-like drag-restore (ticket 105): the first drag move
        // leaves maximize, THEN the delta applies to the restored rect.
        // A bare click (down + up, no move) never restores.
        const restored = restoredState(viewport);
        if (!sameWindowGeometry(restored, state)) emit(restored);
      }
      const placed = clampWindowPosition(
        state.x + dx,
        state.y + dy,
        state.width,
        state.height,
        viewport,
      );
      if (placed.x === state.x && placed.y === state.y) return;
      emit({ ...state, x: placed.x, y: placed.y });
    },
    resizeBy(edge, dx, dy, viewport) {
      if (!state.open || state.maximized) return;
      let x = state.x;
      let y = state.y;
      let width = state.width;
      let height = state.height;
      // East face: the right edge tracks the pointer; the left edge stays.
      // The face never crosses the viewport's right edge.
      if (edge === "e" || edge === "ne" || edge === "se") {
        width = clampScalar(
          state.width + dx,
          FLOATING_WINDOW_MIN_WIDTH,
          Math.max(FLOATING_WINDOW_MIN_WIDTH, viewport.width - state.x),
        );
      }
      // West face: the left edge tracks the pointer; the right edge stays
      // put (the size compensates). The left edge never crosses the
      // viewport's left edge, and the minimum size caps the travel.
      if (edge === "w" || edge === "nw" || edge === "sw") {
        const left = clampScalar(
          state.x + dx,
          0,
          state.x + state.width - FLOATING_WINDOW_MIN_WIDTH,
        );
        width = state.x + state.width - left;
        x = left;
      }
      // South face: the bottom edge tracks the pointer; the top edge stays.
      if (edge === "s" || edge === "se" || edge === "sw") {
        height = clampScalar(
          state.height + dy,
          FLOATING_WINDOW_MIN_HEIGHT,
          Math.max(FLOATING_WINDOW_MIN_HEIGHT, viewport.height - state.y),
        );
      }
      // North face: the top edge tracks the pointer; the bottom edge stays.
      if (edge === "n" || edge === "ne" || edge === "nw") {
        const top = clampScalar(
          state.y + dy,
          0,
          state.y + state.height - FLOATING_WINDOW_MIN_HEIGHT,
        );
        height = state.y + state.height - top;
        y = top;
      }
      // Position validity last (the ticket's "…then clamp"): identity in
      // the normal case, decisive only for windows already hanging
      // off-screen.
      const placed = clampWindowPosition(x, y, width, height, viewport);
      x = placed.x;
      y = placed.y;
      if (
        x === state.x &&
        y === state.y &&
        width === state.width &&
        height === state.height
      ) {
        return;
      }
      emit({ ...state, x, y, width, height });
    },
    toggleMaximize(viewport) {
      if (!state.open) return;
      if (state.maximized) {
        const restored = restoredState(viewport);
        if (!sameWindowGeometry(restored, state)) emit(restored);
        return;
      }
      preMaximize = {
        x: state.x,
        y: state.y,
        width: state.width,
        height: state.height,
      };
      const fill = maximizedWindowPlacement(viewport);
      emit({
        ...state,
        maximized: true,
        x: fill.x,
        y: fill.y,
        width: fill.width,
        height: fill.height,
      });
    },
  };
}
