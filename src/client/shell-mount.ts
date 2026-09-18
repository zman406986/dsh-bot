/**
 * Wrapper shell STAGING mount (ticket 78, ADR-0020 slice 2 — the staging
 * half only; `docs/adr/0020` "Staging" paragraph).
 *
 * ADR-0020's vehicle is our own client module registering our own
 * application frame over the shipped dsh client runtime. The election is
 * staged: the shell first surfaces as a keyed `main` page (the layout's page
 * surface — key ours by default, the only shipped key being
 * `"conversation"`), opened through the verified
 * `ctx.layout.selectPanel(panelId)` verb (ui-layout `lib/client.js:399-412`;
 * `wrapper-vehicle-seams.md` Finding 5, `dsh-capsule-seams.md` Seam 4's
 * status correction). Only AFTER the surfaces are real (ticket 80's
 * conversation surface) does the registration flip into the `root` single
 * slot — and that cutover slice, plus retiring the capsule/launcher overlay
 * entries, is deliberately NOT in this module: nothing here registers into
 * `root` (pinned by test).
 *
 * Fail-safe posture (ADR-0020 property 2, pinned offline where possible):
 * the future `root` registration is DYNAMIC, and dsh's documented cell
 * election takes "the first live (non-abdicated) entry … in priority order"
 * with dynamic entries at a lower priority value than the shipped one
 * (`dsh-client-ui-renderer/lib/types/client/registry.d.ts:24-27, 156-164`).
 * Our frame therefore wins the cell exactly while it stays live; a crash
 * abdicates and the stock dsh app takes the cell back — the degradation mode
 * of "the whole UI is ours" is the ordinary product, never a blank window.
 * {@link shellCellWinner} pins that election rule as a pure decision for the
 * cutover slice's contract tests; the live frame swap / HMR / fallback
 * behavior itself stays live-only (tickets 45/33) and is NOT claimed here.
 *
 * This module is pure registration data + pure decisions: no React, no DOM,
 * no Cordis. Tests assert it directly (offline, S8), matching the
 * overlay/toolview registration-pin style. The launcher's component lives in
 * `shell.tsx`; the live composition (inject → register, feed binding, seat
 * projection) lives in `index.ts`.
 */

import type { ClientLayoutLike } from "./context.js";
import { LOCALE_NAMESPACE, type SlotRegistrationOptions } from "./overlay.js";
import type { RosterPanelState } from "./roster-store.js";
import type { ShellMirror } from "./shell-store.js";

/**
 * The layout's keyed page slot (dsh-owned, ui-layout's AppFrame declares it
 * as the `main` keyed child — the page surface; slot catalog,
 * `dsh-plugin-ui-patterns.md` Finding 5). design-16 §5 barred `main` for the
 * ADDITIVE capsule-era entries; ADR-0020 supersedes that for the wrapper
 * shell's own staged registration (recorded on the ticket and in
 * `overlay.ts`'s header note — the roster overlay entry itself is unchanged).
 */
export const MAIN_PAGE_SLOT = "main";

/**
 * The shipped `main` key (ui-conversation's page). Never ours to claim — a
 * keyed cell the shipped composition already covers is a shadowing election,
 * and staging coexists with the shipped UI by construction.
 */
export const SHIPPED_MAIN_PAGE_KEY = "conversation";

/**
 * Our page key: unclaimed, plugin-prefixed, stable across registrations and
 * re-applies (HMR) — the launcher opens THIS key and the page registration
 * claims THIS key; drift between the two would make `selectPanel` throw.
 */
export const SHELL_PAGE_KEY = "multitask-dispatcher-shell";

/** Registration options for one keyed `main` page entry (keyed-cell shape). */
export interface ShellPageRegistrationOptions {
  /** The shipped keyed page slot. */
  readonly name: string;
  /** The keyed cell: our page key, ours by default. */
  readonly key: string;
  /** Locale namespace declared on the entry so the kit's `t` seat binds. */
  readonly locale: string;
}

/** Build the shell page's `main` registration options (stable, pure). */
export function shellPageRegistration(): ShellPageRegistrationOptions {
  return {
    name: MAIN_PAGE_SLOT,
    key: SHELL_PAGE_KEY,
    locale: LOCALE_NAMESPACE,
  };
}

/**
 * The launcher affordance's additive `shell.overlay` entry id (ticket 78
 * staging): a chip that opens the shell page via `ctx.layout.selectPanel`.
 * Distinct from the roster entry id — coexistence in a list slot is by
 * unique id, not shadowing. Retired at the cutover together with the capsule
 * (the staging vehicles; ticket 78's cutover slice).
 */
export const SHELL_LAUNCHER_ENTRY_ID = "multitask-dispatcher-shell-launcher";

/**
 * Sort position of the launcher chip in the overlay list, one step BEFORE
 * the capsule's `-10`: it renders under the capsule chip (the entry
 * self-positions top-right below it) and an expanded capsule card paints
 * over it rather than the reverse.
 */
export const SHELL_LAUNCHER_OVERLAY_ORDER = -11;

/** Build the launcher's `shell.overlay` registration options (pure). */
export function shellLauncherRegistration(): SlotRegistrationOptions {
  return {
    name: "shell.overlay",
    id: SHELL_LAUNCHER_ENTRY_ID,
    order: SHELL_LAUNCHER_OVERLAY_ORDER,
    locale: LOCALE_NAMESPACE,
  };
}

/** Copy key for the launcher chip's label — REUSED, no new locale key. */
export const SHELL_LAUNCHER_LABEL_KEY = "shell.title";

/**
 * Outcomes of the page-open decision (pure, honest): `opened` — the host
 * accepted the selection; `no-layout` — no layout service on this runtime
 * (optional face — degrade, never block); `panel-not-registered` — the host
 * rejected the key (the verified verb throws on unregistered `main` panels,
 * ui-layout `lib/client.js:399-412`). There is deliberately no success
 * surface beyond the page actually opening: the launcher renders no claim.
 */
export type ShellPageOpenOutcome =
  | { readonly kind: "opened" }
  | { readonly kind: "no-layout" }
  | { readonly kind: "panel-not-registered" };

/**
 * Open the shell page through the layout controller, containing every
 * failure the verified seam documents. A thrown `selectPanel` (unknown key)
 * becomes an honest outcome instead of a crash — a crash here would abdicate
 * the launcher's overlay entry for no reason.
 */
export function openShellPage(
  layout: ClientLayoutLike | undefined,
  pageKey: string,
): ShellPageOpenOutcome {
  if (layout === undefined || typeof layout.selectPanel !== "function") {
    return { kind: "no-layout" };
  }
  try {
    layout.selectPanel(pageKey);
    return { kind: "opened" };
  } catch {
    return { kind: "panel-not-registered" };
  }
}

/**
 * The `root` single slot (dsh-owned; occupied by the shipped AppFrame). Its
 * contract note says "DO NOT register here" — coexistence etiquette for
 * add-on plugins that ADR-0020 deliberately retires for the wrapper shell at
 * the CUTOVER, with the fail-safe below as the recorded safety argument.
 * Nothing registers into it today (pinned by test); this constant is the
 * cutover slice's named target, kept next to the election rule it rides on.
 */
export const ROOT_FRAME_SLOT = "root";

/**
 * The priority value the cutover registration will carry. dsh assigns
 * dynamic registrations a LOWER priority value than the shipped frame's
 * (dsh-owned, unspecified) value — that is exactly what makes the dynamic
 * entry win a shadowed cell while live (`registry.d.ts:24-27`). Only the
 * relative order is contract; the shipped frame's actual number is not ours
 * to know.
 */
export const SHELL_ROOT_DYNAMIC_PRIORITY = 1;

/** One entry competing for a slot cell (the fail-safe model's input). */
export interface ShellCellEntry {
  /** Stable entry identity (ours are `multitask-dispatcher-` prefixed). */
  readonly entryId: string;
  /**
   * The cell's priority value; the winner scan takes the first live entry in
   * ascending order (lower value first, the same direction as the overlay
   * list's `order ?? 0` sort).
   */
  readonly priority: number;
  /**
   * A crashed entry abdicates its cell (per-entry error boundary,
   * `registry.d.ts:156-164`); an abdicated entry never wins.
   */
  readonly abdicated?: boolean;
}

/**
 * The cell-election decision the `root` fail-safe rides on, pinned as a pure
 * function (ADR-0020 property 2): the first live (non-abdicated) entry in
 * priority order wins. Because the cutover registration is DYNAMIC (lower
 * priority value than the shipped frame), our frame wins the cell exactly
 * while it stays live — and the moment it abdicates, the shipped app takes
 * the cell back. Ties resolve to list order (first registered wins), the
 * scan being order-stable by construction.
 */
export function shellCellWinner(
  entries: readonly ShellCellEntry[],
): ShellCellEntry | null {
  let winner: ShellCellEntry | null = null;
  for (const entry of entries) {
    if (entry.abdicated === true) continue;
    if (winner === null || entry.priority < winner.priority) winner = entry;
  }
  return winner;
}

/**
 * The hosted roster panel's store state for one shell mirror (the right
 * seat's projection; the composition in `index.ts` keeps one
 * `createRosterPanel` store synced to the SELECTED session's mirror):
 *
 * - no mirror, or a `cleared` one (host wrote `null` on deactivation) —
 *   `null`: the session is not one of our dispatcher sessions, so the pane
 *   hosts NO panel at all (never an invented roster, never loading copy);
 * - an `unavailable` mirror (corrupt payload) — `{kind: "invalid"}`: the
 *   panel renders its single honest unavailable line;
 * - a parsed snapshot — `{kind: "snapshot"}`: the panel applies its OWN
 *   staleness and partition rules (one stale rule, one section semantic —
 *   never a second).
 */
export function shellSeatPanelState(
  mirror: ShellMirror | undefined,
): RosterPanelState | null {
  if (mirror === undefined || mirror.kind === "cleared") return null;
  if (mirror.kind === "unavailable") return { kind: "invalid" };
  return { kind: "snapshot", snapshot: mirror.snapshot };
}

/**
 * The right seat's HOST-OR-NOT gate (the pure decision behind
 * `ShellHosts.rosterPanel`): a panel is hosted only when
 * {@link shellSeatPanelState} yields a state — never for a plain chat.
 * Exported so tests pin the gate without invoking the panel component
 * offline (S8: rendering is build + typecheck territory).
 */
export function shellSeatHostsPanel(mirror: ShellMirror | undefined): boolean {
  return shellSeatPanelState(mirror) !== null;
}
