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
  /** The window's size — fixed for now (no resize affordance is ticketed). */
  readonly width: number;
  readonly height: number;
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
   * A no-op while closed (nothing visible to move).
   */
  moveBy(dx: number, dy: number, viewport: WindowViewport): void;
}

/** The window's fixed size (px) — fits the shell's three panes comfortably. */
export const FLOATING_WINDOW_WIDTH = 760;
export const FLOATING_WINDOW_HEIGHT = 520;

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

export function createFloatingWindowStore(): FloatingWindowStore {
  let state: FloatingWindowState = {
    open: false,
    openEpoch: 0,
    x: 0,
    y: 0,
    width: FLOATING_WINDOW_WIDTH,
    height: FLOATING_WINDOW_HEIGHT,
  };
  let version = 0;
  let box: FloatingWindowBox = { state, version };
  const listeners = new Set<() => void>();

  function emit(next: FloatingWindowState): void {
    state = next;
    version += 1;
    box = { state, version };
    for (const listener of [...listeners]) listener();
  }

  function open(viewport?: WindowViewport): void {
    if (state.open) return;
    const vp = viewport ?? FALLBACK_VIEWPORT;
    const firstOpen = state.openEpoch === 0;
    const placed = firstOpen
      ? defaultWindowPlacement(state, vp)
      : // Reopen where it was — re-clamped against the live viewport.
        clampWindowPosition(state.x, state.y, state.width, state.height, vp);
    emit({
      ...state,
      open: true,
      openEpoch: state.openEpoch + 1,
      x: placed.x,
      y: placed.y,
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
  };
}
