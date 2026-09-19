/**
 * Wrapper shell mount (ticket 78, ADR-0020 slice 2 — staging AND cutover
 * contracts; `docs/adr/0020` "Staging" paragraph).
 *
 * ADR-0020's vehicle is our own client module registering our own
 * application frame over the shipped dsh client runtime. The election was
 * staged: the shell first surfaced as a keyed `main` page (the layout's page
 * surface — key ours by default, the only shipped key being
 * `"conversation"`), opened through the verified
 * `ctx.layout.selectPanel(panelId)` verb (ui-layout `lib/client.js:399-412`;
 * `wrapper-vehicle-seams.md` Finding 5, `dsh-capsule-seams.md` Seam 4's
 * status correction). With the surfaces real (ticket 80's conversation
 * surface landed), the CUTOVER slice registers the frame into the `root`
 * single slot: {@link shellRootRegistration} is that contract and the live
 * composition registers it in `index.ts` (the capsule/launcher overlay
 * retirement rides the same slice).
 *
 * Fail-safe posture (ADR-0020 property 2, pinned offline where possible):
 * the `root` registration carries an EXPLICIT shadowing priority
 * ({@link SHELL_ROOT_DYNAMIC_PRIORITY}; ticket 85, 2026-09-19 — the shipped
 * single-slot register defaults an absent priority to 0, the shipped frame's
 * own value, and THROWS on that collision instead of shadowing), and dsh's
 * cell election takes "the first live (non-abdicated) entry … in priority
 * order" over entries kept sorted ASCENDING by priority (`registry.d.ts:156-164`;
 * the shipped SlotCore sorts `(priority ?? 0)` ascending at insert and its
 * error text pins the direction: "lowest renders"). Our frame therefore wins
 * the cell exactly while it stays live; a crash
 * abdicates and the stock dsh app takes the cell back — the degradation mode
 * of "the whole UI is ours" is the ordinary product, never a blank window.
 * {@link shellCellWinner} pins that election rule as a pure decision, and
 * the fake-fiber tests pin the unload abdication path (teardown empties the
 * cell; the shipped frame is the surviving winner); the live frame swap /
 * HMR / fallback behavior itself stays live-only (tickets 45/33) and is NOT
 * claimed here.
 *
 * This module is pure registration data + pure decisions: no React, no DOM,
 * no Cordis. Tests assert it directly (offline, S8), matching the
 * overlay/toolview registration-pin style. The live composition (inject →
 * register, feed binding, seat projection) lives in `index.ts`.
 *
 * Ticket 89 (2026-09-19): the staging launcher's contracts —
 * `SHELL_LAUNCHER_ENTRY_ID`, `SHELL_LAUNCHER_OVERLAY_ORDER`,
 * `shellLauncherRegistration`, `SHELL_LAUNCHER_LABEL_KEY`,
 * `ShellPageOpenOutcome`, `openShellPage`, `ShellLauncherLayout`,
 * `createShellLauncherLayout` — were DELETED with the retired vehicle
 * (nothing consumed them post-cutover). The LIVE main-page contracts
 * (`MAIN_PAGE_SLOT`, `SHIPPED_MAIN_PAGE_KEY`, `SHELL_PAGE_KEY`,
 * `shellPageRegistration`) and every `root`-election contract stay.
 */

import { LOCALE_NAMESPACE } from "./overlay.js";
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
 * The `root` single slot (dsh-owned; occupied by the shipped AppFrame). Its
 * contract note says "DO NOT register here" — coexistence etiquette for
 * add-on plugins that ADR-0020 deliberately retires for the wrapper shell at
 * the CUTOVER, with the fail-safe below as the recorded safety argument. The
 * cutover registers the wrapper shell frame here as the DYNAMIC entry (the
 * {@link shellRootRegistration} contract, composed in `index.ts`); the
 * shipped `main` keyed page is NOT claimed by it — the election shadows the
 * frame, never a keyed page the shipped composition covers.
 */
export const ROOT_FRAME_SLOT = "root";

/**
 * The priority value the cutover registration CARRIES — explicit, on the
 * options sent to `ctx.slots.register` (ticket 85, 2026-09-19; the ticket-78
 * cutover shipped no priority and the loader entry died on the collision).
 *
 * Verified against the installed 0.1.5-rc.1 client (read-only):
 * - The shipped single-slot register defaults an ABSENT priority to 0
 *   (`a = t.priority ?? 0`) and THROWS on a same-priority registration —
 *   `single slot "root" already has a registration at priority 0 … —
 *   register at a different priority to shadow it (lowest renders)` — the
 *   exact live pass-3 error (dsh-web-frontend `dist/assets/index-BKQ_L1z6.js`,
 *   SlotCore.register, minified: single case finds
 *   `entries.find(g => (g.options.priority ?? 0) === a)` and throws).
 * - The winner is the first live (non-abdicated) entry of the cell, and the
 *   registry keeps entries sorted ASCENDING by `(priority ?? 0)` at insert
 *   (`p.sort((m,g)=>(m.options.priority??0)-(g.options.priority??0))`;
 *   `entriesOfSlot` walks that order — same bundle; "lowest renders";
 *   `dsh-client-ui-renderer/lib/types/client/registry.d.ts:156-164`).
 * - The shipped AppFrame holds priority 0: it registers
 *   `{name: "root", locale: "common", children, store}` with NO priority
 *   (dsh-client-ui-layout `lib/client.js:524-531`), so `?? 0` lands it at 0 —
 *   confirmed live by the pass-3 error text "(registered by Ba)".
 * - The caller's options pass through to this registry UNCHANGED: the browser
 *   bundle contains no priority allocator (no `allocatePriority`/`nextPriority`
 *   anywhere in it), so the host-side runner's auto-allocation
 *   (`nextPriority = 0`, `allocatePriority: () => --this.nextPriority` —
 *   dsh-cordis-client-runner `lib/client.js:384, 606`, first dynamic slot
 *   allocation = -1) does NOT apply to loader-entry client modules — the live
 *   pass-3 registration arrived at priority 0, proving it.
 *
 * `-1` is therefore "one below the shipped frame": below 0 it wins the
 * ascending election (shadows the AppFrame) and it cannot collide with the
 * frame's 0. It is also the host runner's own first dynamic allocation value,
 * so the choice matches the idiom the host itself would have assigned.
 * `registry.d.ts:24-27`'s "a dynamically registered entry is assigned a lower
 * priority than the shipped one" describes exactly this outcome; 0.1.5-rc.1
 * simply leaves the assignment to the caller.
 */
export const SHELL_ROOT_DYNAMIC_PRIORITY = -1;

/**
 * Registration options for the `root` single-slot entry (the cutover's frame
 * election). A single slot takes NO `id` and NO `key` — the cell has one
 * occupant per election — and the runtime catalog's own example for `root` is
 * exactly `ctx.slots.inject('root', () =>
 * ctx.slots.register({ name: 'root' }, component))` with
 * `registerOptions: []` (dsh-cordis-client-runner lib/client.js:3514-3520);
 * the shipped AppFrame registers the same way, adding only its `locale` and
 * the child-slot declarations our self-contained frame does not need
 * (`{name: "root", locale: "common", children, store}`, dsh-client-ui-layout
 * lib/client.js:524-531). We add the same `locale` so the entry declares our
 * namespace, matching every other registration this module ships — plus the
 * EXPLICIT shadowing {@link SHELL_ROOT_DYNAMIC_PRIORITY} (ticket 85, verified
 * host rule: an absent priority defaults to 0, collides with the shipped
 * frame's 0, and the register THROWS — the caller must carry the value).
 */
export interface ShellRootRegistrationOptions {
  /** The dsh-owned single slot (the shadowing election's target). */
  readonly name: string;
  /** Locale namespace declared on the entry so the kit's `t` seat binds. */
  readonly locale: string;
  /**
   * The explicit shadowing priority (ticket 85): `-1`, one below the shipped
   * frame's effective 0 — wins the ascending "lowest renders" election while
   * live, and cannot collide with the frame's own registration.
   */
  readonly priority: number;
}

/**
 * Build the wrapper shell frame's `root` registration options (stable,
 * pure). This is the ADR-0020 cutover registration: it carries the explicit
 * shadowing priority ({@link SHELL_ROOT_DYNAMIC_PRIORITY}, ticket 85), so the
 * frame wins the cell exactly while it stays live, and abdication — a render
 * crash through the per-entry boundary ("for shadowing kinds the report
 * abdicates the entry, the outlet re-renders onto the cell's next survivor",
 * dsh-client-ui-renderer lib/client.js:507-514) or module unload/HMR (the
 * caller's-fiber cascade, `registry.d.ts:77-83`) — hands the cell back to
 * the shipped app frame.
 */
export function shellRootRegistration(): ShellRootRegistrationOptions {
  return {
    name: ROOT_FRAME_SLOT,
    locale: LOCALE_NAMESPACE,
    priority: SHELL_ROOT_DYNAMIC_PRIORITY,
  };
}

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
