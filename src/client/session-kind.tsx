/**
 * Session-kind indicators (ticket 123; ADR-0024 rider + rider addendum).
 *
 * The owner ruling: small marks separating **dispatcher**, **worker**
 * (subagent), and **normal** sessions in stock dsh. Native posture stands —
 * additive glyphs only, nothing displaced, no floating surface.
 *
 * ## Where each kind can be marked (verified against dsh 0.2.1-rc.2)
 *
 * - **Only the sidebar leading cell is licensed.** ADR-0024's 2026-10-18
 *   rider permits "exactly one additional additive registration, and it is
 *   this one ... no other slot is licensed by this rider". That one seat is
 *   `sidebar.session.row.leading`.
 * - **Workers are not sidebar rows.** Subagent sessions carry the durable
 *   header flag `origin: 'subagent'` (`dsh-subagent/lib/index.js:354`) and
 *   the stock sidebar drops them (`dsh-client-ui-workspace/lib/client.js:965`).
 *   `sidebar.session.row.leading` therefore never mounts for a worker, so the
 *   worker half of the owner's three-way request has no licensed seat.
 * - **The conversation header is NOT composed (declined, not forgotten).**
 *   `conversation.session.header.actions` is a real additive `list` seat and
 *   would be the worker's only visible location, but ADR-0024's rider does
 *   not license it. Ticket 123 records the header part as declined pending a
 *   fresh dated human ruling extending the rider. The generic glyph factory
 *   below still supports the `worker` kind so that ruling lands as a
 *   composition edit, not a rewrite.
 * - **`conversation.session.header.lineage` remains an unsafe seat** if that
 *   ruling ever comes: it is a `single` slot
 *   (`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:225`)
 *   and `dsh-client-ui-subagent` registers an unconditional entry into it at
 *   the default priority 0 (`dsh-client-ui-subagent/lib/client.js:978-982`).
 *   The shipped SlotCore throws on a same-priority second registration and
 *   renders the LOWEST priority first, so a second entry would either throw
 *   or displace the stock breadcrumb renderer.
 * - **`sidebar.session.row.leading`** is a `list` slot, root scope, owner
 *   `{sessionId}` (`dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts:123`,
 *   rendered `:2306`). The stock schedule plugin occupies it at order 10
 *   (`dsh-client-ui-schedule/lib/client.js:7528`), so the dispatcher entry
 *   belongs at a HIGHER order and never shadows it.
 *
 * ## How each kind is identified
 *
 * - **Worker:** `origin === 'subagent'` — a durable session-header fact
 *   (`dsh-session/lib/types/types.d.ts:78-82`), surfaced to the client on the
 *   list row (`SessionSummary.origin`), and the signal ADR-0027 §Settled 5
 *   names as the only one after the worker preset row was removed.
 *   Resolution stays here so the declined header marker can be composed
 *   unchanged if a future ruling licenses it; nothing renders it today.
 * - **Dispatcher:** `projectionValues.sessionKind === 'dispatcher'` — a
 *   projection our own adapter registers (`src/adapter/session-kind-projection.ts`).
 *   It folds the `command/run` + `command/done` pair the host already writes
 *   when `/dsh-bot` succeeds, so the mark is durable from session start and
 *   needs no event of our own. The withdrawn `/dispatcher-stop` command's
 *   settlements (ADR-0030) clear the mark only when replaying legacy logs;
 *   today the mark clears implicitly via host disposal or plugin unload.
 *   (`projectionValues.agentPreset` was the earlier candidate; it is unusable
 *   here — every durable header on this install reads `"standard"` and no
 *   `multitask-dispatcher` preset row exists.)
 * - **Normal:** everything else, including an unknown or missing row — the
 *   resolver fails closed to `normal`, and `normal` renders nothing.
 *
 * Keys are read defensively: the slot payload is only `{sessionId}`, and a
 * snapshot that has not learned the session yet yields `normal`.
 *
 * ## The dispatcher mark is a small bot portrait (ticket 146)
 *
 * The owner's 2026-10-27 instruction fixed the mark's visual form (ADR-0024's
 * rider had left it TBD): the dispatcher cell renders a tiny **bot portrait**
 * as an inline SVG, not a text character. The drawing is authored here from
 * scratch — no asset file, no data URI, no copied path table — and painted
 * only with `currentColor` plus the host's `--dsw-alias-*` tokens, so it
 * follows the shell's light/dark setting.
 *
 * Motion is CSS `@keyframes` emitted by the component through a `<style>`
 * element (the roster panel's idiom, `panel.tsx:303`): a slow bob and a
 * quicker blink. Both are disabled under `prefers-reduced-motion: reduce`,
 * leaving the static portrait. The seat is idle-only (the host unmounts the
 * leading cell while a session runs), so no running state is chased here.
 */

import type { JSX } from "react";
import { LOCALE_NAMESPACE, type TranslateFn } from "./overlay.js";

/**
 * The 16px leading cell of a stock sidebar session row (dsh-owned LIST slot).
 * Only the RESTING cell renders it (idle, non-archived, non-blank).
 */
export const SIDEBAR_LEADING_SLOT = "sidebar.session.row.leading";

/**
 * Dispatcher cell order: ABOVE the stock schedule mark (10) so the stock
 * occupant always renders first inside the 16px cell.
 *
 * Composed by `apply` — the adapter's `sessionKind` projection gives the
 * glyph a durable dispatcher identity to key on.
 */
export const DISPATCHER_GLYPH_ORDER = 20;

/** Entry id the dispatcher cell entry carries. */
export const DISPATCHER_GLYPH_ENTRY_ID = "multitask-dispatcher-kind";

/**
 * Worker marker glyph, retained but NOT composed: the header seat it belongs to
 * is not licensed by ADR-0024's rider (ticket 123 records it as declined).
 */
export const WORKER_GLYPH = "↳";

/**
 * Stylesheet for the dispatcher bot portrait (ticket 146). Emitted by the
 * component itself through a `<style>` element — exactly the roster panel's
 * idiom (`panel.tsx:303`) — so the mark needs no build-toolchain change and
 * unmounts with the row. Every class and keyframe name is
 * `multitask-dispatcher-` prefixed; the only colours are `currentColor` and
 * the host's `--dsw-alias-*` token layer; both animations turn off under
 * `prefers-reduced-motion: reduce`, leaving the static portrait.
 *
 * Motion is a slow vertical bob of the whole portrait plus a rarer blink of
 * the two eyes. Nothing is state-driven: the leading cell is idle-only (the
 * host unmounts it while a session runs), so the portrait only has to look
 * alive while at rest.
 */
export const SESSION_KIND_GLYPH_CSS = `
.multitask-dispatcher-kind-glyph{display:inline-flex;align-items:center;justify-content:center;width:16px;height:20px;line-height:0;overflow:hidden}
.multitask-dispatcher-kind-glyph__bot{display:block;transform-origin:center;animation:multitask-dispatcher-kind-glyph-bob 3.2s ease-in-out infinite}
.multitask-dispatcher-kind-glyph__eye{fill:var(--dsw-alias-label-primary);transform-box:fill-box;transform-origin:center;animation:multitask-dispatcher-kind-glyph-blink 4.8s ease-in-out infinite}
@keyframes multitask-dispatcher-kind-glyph-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-.75px)}}
@keyframes multitask-dispatcher-kind-glyph-blink{0%,90%,96%,100%{transform:scaleY(1)}93%{transform:scaleY(.15)}}
@media (prefers-reduced-motion: reduce){.multitask-dispatcher-kind-glyph__bot,.multitask-dispatcher-kind-glyph__eye{animation:none}}
`;

/**
 * The dispatcher portrait: an original 16×16 inline-SVG bot head — antenna
 * with a tip dot, a rounded head with small side ears, two eyes and a short
 * mouth line. Authored here from scratch (ticket 146 constraints): no asset
 * file, no data URI, no copied path table, no motion table.
 *
 * `aria-hidden` is deliberate: the wrapping span carries `role="img"` and the
 * localized label, so the drawing adds no second announcement. Colours are
 * the row's inherited `currentColor` plus one host token for the eyes
 * (`SESSION_KIND_GLYPH_CSS`), never a raw literal.
 */
function DispatcherPortrait(): JSX.Element {
  return (
    <svg
      className="multitask-dispatcher-kind-glyph__bot"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {/* Antenna: a short stem and a tip dot. */}
      <line
        x1="8"
        y1="1.4"
        x2="8"
        y2="3.6"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      <circle cx="8" cy="1.3" r=".9" fill="currentColor" />
      {/* Head: a rounded shell with a whisper of fill so it reads as a face. */}
      <rect
        x="1.9"
        y="3.8"
        width="12.2"
        height="9.6"
        rx="3.2"
        fill="currentColor"
        fillOpacity=".1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      {/* Side ears. */}
      <rect
        x=".8"
        y="7.1"
        width="1.1"
        height="2.6"
        rx=".55"
        fill="currentColor"
      />
      <rect
        x="14.1"
        y="7.1"
        width="1.1"
        height="2.6"
        rx=".55"
        fill="currentColor"
      />
      {/* Eyes: the only animated parts (the blink). */}
      <circle
        className="multitask-dispatcher-kind-glyph__eye"
        cx="5.8"
        cy="8.1"
        r="1.05"
      />
      <circle
        className="multitask-dispatcher-kind-glyph__eye"
        cx="10.2"
        cy="8.1"
        r="1.05"
      />
      {/* Mouth: one short, calm line. */}
      <line
        x1="6.3"
        y1="11"
        x2="9.7"
        y2="11"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The projection key our adapter registers for dispatcher identity
 * (`src/adapter/session-kind-projection.ts`). Read-only: this module never
 * writes a session marker.
 */
export const DISPATCHER_PROJECTION_KEY = "sessionKind";

/** The wire value the projection publishes for an active dispatcher. */
export const DISPATCHER_PROJECTION_VALUE = "dispatcher";

/** Locale keys for the two glyph labels (accessible name + tooltip). */
export const SESSION_KIND_COPY_KEYS = {
  dispatcher: "indicator.dispatcher",
  worker: "indicator.worker",
} as const;

/** The three kinds the owner ruling names. */
export type SessionKind = "dispatcher" | "worker" | "normal";

/**
 * The subset of a client session-list row this module reads
 * (`SessionSummary` in `dsh-api-session-controller/lib/types/client/sessions/service.d.ts:17-44`).
 * `origin` is a header fact surfaced at the top level; `agentPreset` is a
 * host-computed projection value carried under `projectionValues` (the same
 * read stock performs at `dsh-client-ui-workspace/lib/client.js:1453`).
 * Loosely typed on purpose: the slot hands us renderer-owned props and a
 * malformed/missing row must degrade to `normal`, never throw.
 */
export interface SessionKindFactsLike {
  readonly origin?: unknown;
  readonly projectionValues?: {
    readonly sessionKind?: unknown;
    readonly agentPreset?: unknown;
  } | null;
}

/** The subset of `SessionListState` the selector reads. */
export interface SessionsSnapshotLike {
  readonly byId?: Readonly<Record<string, SessionKindFactsLike | undefined>>;
}

/**
 * Pure kind resolution over one session's client-visible facts.
 *
 * Order matters: `origin` wins over the projection, because workers inherit
 * the dispatcher's context (ADR-0027 §Settled 5) — checking the projection
 * first would label a worker as a dispatcher.
 *
 * Never throws: a missing row, a non-object, or wrong-typed fields resolve to
 * `normal`, which renders nothing (fail closed, never mislabel).
 */
export function resolveSessionKind(
  facts: SessionKindFactsLike | null | undefined,
): SessionKind {
  if (typeof facts !== "object" || facts === null) return "normal";
  if (facts.origin === "subagent") return "worker";
  const kind =
    typeof facts.projectionValues === "object" &&
    facts.projectionValues !== null
      ? facts.projectionValues.sessionKind
      : undefined;
  if (kind === DISPATCHER_PROJECTION_VALUE) return "dispatcher";
  return "normal";
}

/**
 * One list-slot entry's registration options (the shape the stock schedule
 * and subagent packages use: `name` + unique `id` + `order` + `locale`).
 * `priority` is deliberately omitted: list entries are keyed by `id`, and the
 * default `(priority ?? 0)` is additive beside the stock entries.
 */
export interface SessionKindGlyphRegistrationOptions {
  readonly name: string;
  readonly id: string;
  readonly order: number;
  readonly locale: string;
}

/**
 * The dispatcher cell's sidebar registration — the ONE additive registration
 * ADR-0024's rider licenses. Composed by `apply`: the `sessionKind` projection
 * marks an activated dispatcher session durably, so the glyph has a real
 * identity to key on.
 *
 * A worker/header registration is deliberately absent: that seat is not
 * licensed (ticket 123 §B, declined 2026-10-22).
 */
export function dispatcherGlyphRegistration(): SessionKindGlyphRegistrationOptions {
  return {
    name: SIDEBAR_LEADING_SLOT,
    id: DISPATCHER_GLYPH_ENTRY_ID,
    order: DISPATCHER_GLYPH_ORDER,
    locale: LOCALE_NAMESPACE,
  };
}

/** The standard selector-hook seat (`useSessions`) as this module uses it. */
export type UseSessionsLike = (
  selector: (state: SessionsSnapshotLike) => SessionKind,
) => SessionKind;

/** Props a rendered glyph receives: the slot owner payload + standard hooks. */
export interface SessionKindGlyphProps {
  /** The row/session this cell belongs to (`sidebar.session.row.leading` owner). */
  readonly sessionId?: string;
  /** Root standard hook over the session list (`dsh-client-ui-session`). */
  readonly useSessions?: UseSessionsLike;
}

type MarkedKind = Exclude<SessionKind, "normal">;

/**
 * The resolved glyph body. A separate component on purpose: it always calls
 * `useSessions`, so the outer factory never has a conditional hook.
 *
 * `normal` — and any session the snapshot cannot resolve — renders `null`.
 */
function KindGlyphBody(props: {
  readonly kind: MarkedKind;
  readonly label: string;
  readonly sessionId: string;
  readonly useSessions: UseSessionsLike;
}): JSX.Element | null {
  const resolved = props.useSessions((state) =>
    resolveSessionKind(state?.byId?.[props.sessionId]),
  );
  if (resolved !== props.kind) return null;
  const mark = (
    <span
      className="multitask-dispatcher-kind-glyph"
      data-session-kind={props.kind}
      role="img"
      aria-label={props.label}
      title={props.label}
    >
      {props.kind === "dispatcher" ? <DispatcherPortrait /> : WORKER_GLYPH}
    </span>
  );
  // The worker mark stays a bare text node; only the dispatcher portrait brings
  // its stylesheet, as a sibling of the mark so the mark's own text content
  // stays empty (the cell is glyph-only).
  if (props.kind !== "dispatcher") return mark;
  return (
    <>
      <style>{SESSION_KIND_GLYPH_CSS}</style>
      {mark}
    </>
  );
}

/**
 * Build the glyph component for one kind. The factory binds the translate
 * seat and the mark at registration time, so the renderer-controlled props
 * face stays fully defensive:
 *
 * - missing `sessionId` or `useSessions` → `null` (no hook called);
 * - a session of another kind → `null`;
 * - the matching kind → one `<span role="img">` carrying the mark (the
 *   dispatcher bot portrait, or the worker character), its accessible label,
 *   and a `data-session-kind` hook for styling/tests.
 */
export function createSessionKindGlyph(
  kind: MarkedKind,
  t: TranslateFn,
): (props: SessionKindGlyphProps) => JSX.Element | null {
  const label = t(SESSION_KIND_COPY_KEYS[kind]);
  return function SessionKindGlyph(
    props: SessionKindGlyphProps,
  ): JSX.Element | null {
    const { sessionId, useSessions } = props;
    if (
      useSessions === undefined ||
      typeof sessionId !== "string" ||
      sessionId.length === 0
    ) {
      return null;
    }
    return (
      <KindGlyphBody
        kind={kind}
        label={label}
        sessionId={sessionId}
        useSessions={useSessions}
      />
    );
  };
}
