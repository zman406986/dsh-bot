/**
 * The ONE pure formatting leaf shared by every client row (readable-status
 * display).
 *
 * Nothing here knows about React, the DOM, Cordis, or a specific tool. The
 * roster panel, the toolview parsers/renderers, the shell sidebar, and the
 * dispatch card all import from this module, so a second formatter cannot
 * drift into existence:
 *
 * - {@link shortRef} — an id the eye can hold (`worker …6132`,
 *   `session …93a7`, `todo 7`) instead of a UUID or a `session-…` run-on.
 *   The FULL id belongs in the row's details area, never in its first line.
 * - {@link displaySubject} — title first, then kind + short ref. Full ids are
 *   deliberately not a fallback here: they are details.
 * - {@link formatDuration} — `42s`, `3m 5s`, `2h 5m`, `1d 3h`.
 * - {@link formatCount} — locale plural selection over `.one`/`.other` keys.
 * - {@link formatTemplate} — `{lowercase}` placeholder substitution.
 * - {@link statusWordKey} — the raw core FSM status mapped to its localized
 *   human word key. The raw status stays in `data-status` and in every
 *   model-facing string; only the visible word is localized.
 *
 * Pure and dependency-free (S8): asserted directly by offline tests.
 */

/** Locale lookup seat (structurally the bound `t` from `ctx.locale`). */
export type LookupFn = (key: string) => string;

/**
 * Replace `{key}` placeholders with values. An unknown placeholder stays
 * verbatim so a copy typo degrades visibly instead of silently vanishing.
 * Only lowercase alphabetic placeholders are recognized — the client copy
 * rule is lowercase-only (`{title}`, `{count}`, `{subject}`, `{cause}`).
 */
export function formatTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{([a-z]+)\}/g, (match, key: string) =>
    key in values ? (values[key] as string) : match,
  );
}

/**
 * Pick the `.one` or `.other` copy form for a count and substitute it.
 * `keyBase` is the shared prefix (`roster.activity.toolcalls`), so the
 * dictionary carries `….one` and `….other` with identical key sets in both
 * faces. `1 tool call` / `2 tool calls` come from copy, never from an inline
 * plural rule in a component.
 */
export function formatCount(
  lookup: LookupFn,
  keyBase: string,
  count: number,
): string {
  const form = count === 1 ? "one" : "other";
  return formatTemplate(lookup(`${keyBase}.${form}`), {
    count: String(count),
  });
}

/**
 * Compact locale-neutral elapsed text: `42s`, `3m 5s`, `2h 5m`, `1d 3h`.
 * Negative inputs (clock skew) clamp to `0s`.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** The separator between two self-describing facts: space, middle dot, space. */
export const FACT_SEPARATOR = "\u0020\u00b7\u0020";

/**
 * Keep at most two non-empty, distinct facts. Booleans never reach here:
 * a `false`/zero/null fact is omitted before this call, and a duplicate
 * (`worker …6132` already shown as the subject) is dropped.
 */
export function selectFacts(
  facts: readonly (string | null | undefined)[],
): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    if (selected.length >= 2) break;
    if (typeof fact !== "string") continue;
    const text = fact.trim();
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    selected.push(text);
  }
  return selected;
}

/** Render selected facts with the shared ` · ` separator. */
export function formatFacts(
  facts: readonly (string | null | undefined)[],
): string {
  return selectFacts(facts).join(FACT_SEPARATOR);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Last `n` characters (ids shorter than `n` are returned whole). */
function tail(raw: string, n: number): string {
  return raw.length <= n ? raw : raw.slice(-n);
}

/**
 * A short, human-readable reference for an opaque id.
 *
 * - `session-d5c7…93a7` → `session …93a7`
 * - a worker UUID → `worker …6132`
 * - `todo-7` → `todo 7`
 * - `w-7f3a` → `worker 7f3a`
 * - an unrecognized short id → itself (or `<kind> <id>` when a kind is
 *   known); an unrecognized long id → `<kind ?? "worker"> …<last4>`
 *
 * The output NEVER starts with `session-` or with a raw UUID.
 */
export function shortRef(id: string, kind?: string | null): string {
  const raw = id.trim();
  if (raw.length === 0) return "";
  if (UUID_RE.test(raw)) {
    return `${kind ?? "worker"} …${tail(raw, 4)}`;
  }
  const prefixed = /^(session|worker|todo|dispatcher|agent|w)-(.+)$/.exec(raw);
  if (prefixed !== null) {
    const prefix = prefixed[1] ?? "";
    const rest = prefixed[2] ?? "";
    const label = prefix === "w" ? "worker" : prefix;
    if (label === "session") return `session …${tail(rest, 4)}`;
    if (rest.length <= 12) return `${label} ${rest}`;
    return `${label} …${tail(rest, 4)}`;
  }
  if (raw.length >= 24 || /^[0-9a-f]{12,}$/i.test(raw)) {
    return `${kind ?? "worker"} …${tail(raw, 4)}`;
  }
  const label =
    typeof kind === "string" && kind.trim().length > 0 ? kind.trim() : null;
  return label === null ? raw : `${label} ${raw}`;
}

/** The pieces a display subject may be resolved from. */
export interface DisplaySubjectInput {
  readonly title?: string | null;
  readonly id?: string | null;
  readonly kind?: string | null;
}

/**
 * Subject resolution: title → kind + short ref → nothing (the full id lives
 * in the details area, so it is never the visible subject).
 */
export function displaySubject(input: DisplaySubjectInput): string | null {
  const title =
    typeof input.title === "string" ? input.title.trim() : "";
  if (title.length > 0) return title;
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (id.length === 0) return null;
  const kind =
    typeof input.kind === "string" && input.kind.trim().length > 0
      ? input.kind.trim()
      : null;
  return shortRef(id, kind);
}

/** The one human word a worker status renders as (localized by key). */
export type StatusWord =
  | "starting"
  | "working"
  | "adjusting"
  | "done"
  | "failed"
  | "stopped";

const STATUS_WORD_BY_RAW: Readonly<Record<string, StatusWord>> = {
  spawned: "starting",
  running: "working",
  steering: "adjusting",
  completed: "done",
  error: "failed",
  aborted: "stopped",
};

/**
 * Map the raw core FSM vocabulary (or a terminal worker status) onto its
 * human word. Unknown/missing statuses answer `null` so the word is omitted
 * rather than guessed; the raw value still rides `data-status`.
 */
export function statusWord(status: string | null | undefined): StatusWord | null {
  if (typeof status !== "string") return null;
  return STATUS_WORD_BY_RAW[status] ?? null;
}

/** Locale key for a raw status's human word, or `null` when unknown. */
export function statusWordKey(
  status: string | null | undefined,
): string | null {
  const word = statusWord(status);
  return word === null ? null : `status.${word}`;
}
