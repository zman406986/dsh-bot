/**
 * Who one dispatcher is allowed to see — the ONE predicate shared by the
 * prompt roster (`peerRosterFor`) and the peer lane (`message_agent` →
 * `Multitask.sendPeer`).
 *
 * Two dispatcher shapes exist (ADR-0032):
 * - a ROOT dispatcher is user-started and has no dispatcher parent;
 * - a TEAM LEADER was summoned by a dispatcher: a stock top-level session
 *   carrying our own durable dispatcher mark, whose `parentSessionId` is the
 *   summoner. Stock `header.parentSession` is deliberately NOT consulted —
 *   the summoned session has none.
 *
 * Rules:
 * - the same session is never visible;
 * - a ROOT viewer sees another ROOT in the SAME workspace, and its own direct
 *   children (team leaders). It does NOT see grandchildren or another root's
 *   children;
 * - a TEAM-LEADER viewer sees its parent, its siblings (same dispatcher
 *   parent), and its own direct children. Nothing else — not an unrelated
 *   dispatcher, not another team, not a grandparent;
 * - a session carrying a durable dispatcher mark with NO recorded parent is
 *   UNKNOWN LINEAGE, not a root (pre-138 legacy row, or a torn/empty parent).
 *   It sees only its own direct children as a viewer, and a root never sees it
 *   as a root peer. Its children still see it through the parent edge;
 * - cwd is compared ONLY for root↔root edges. Lineage edges inherit the
 *   spawn cwd, so parent/child/sibling checks never look at it. A missing cwd
 *   on either root hides the target (fail closed).
 *
 * Pure and host-free: callers supply the already-resolved facts. No Cordis
 * import, so the rule is unit-testable in isolation.
 */
import { posix, win32 } from "node:path";

/** The dispatch-relevant facts about one session. */
export interface DispatcherVisibilityNode {
  readonly sessionId: string;
  /** The summoning dispatcher's session id (durable mark), if any. */
  readonly parentSessionId?: string;
  /** The live session header's cwd; unknown is represented by absence. */
  readonly cwd?: string;
  /**
   * Whether the session carries our durable dispatcher mark. Only used to
   * interpret a MISSING parent: a marked parentless session has unknown
   * lineage and must not be treated as a root. Absent is treated as unmarked.
   */
  readonly marked?: boolean;
}

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC = /^\\\\/;

/** Whether a path string is a Windows path (drive, UNC, or backslashes). */
function isWindowsPath(path: string): boolean {
  return WINDOWS_DRIVE.test(path) || WINDOWS_UNC.test(path) || path.includes("\\");
}

/**
 * Canonical workspace form: absolute, no trailing separator, and
 * case-insensitive for Windows paths. Empty/absent answers `undefined` so a
 * comparison can fail closed instead of matching two unknowns.
 */
export function normalizeWorkspaceCwd(
  cwd: string | undefined,
): string | undefined {
  if (typeof cwd !== "string") return undefined;
  const trimmed = cwd.trim();
  if (trimmed === "") return undefined;
  if (isWindowsPath(trimmed)) {
    // Windows paths are case-insensitive by host contract, and
    // `win32.resolve` rewrites forward slashes + removes trailing separators.
    const normalized = win32.normalize(win32.resolve(trimmed)).toLowerCase();
    return trimTrailingSeparators(
      normalized,
      "\\",
      win32.parse(normalized).root.length,
    );
  }
  // POSIX: explicit `posix.normalize` (the default `path` module is
  // host-flavored, so on Windows it would rewrite these to backslashes).
  // `posix.normalize` keeps a trailing slash on directory-shaped input, so
  // strip it here (root "/" stays one character).
  return trimTrailingSeparators(posix.normalize(trimmed), "/", 1);
}

/** Drop trailing separators down to (but not including) the root prefix. */
function trimTrailingSeparators(
  normalized: string,
  separator: string,
  rootLength: number,
): string {
  let end = normalized.length;
  while (end > rootLength && normalized[end - 1] === separator) end -= 1;
  return normalized.slice(0, end);
}

/** Same normalized workspace; a missing cwd on either side is never a match. */
export function sameWorkspace(
  left: string | undefined,
  right: string | undefined,
): boolean {
  const a = normalizeWorkspaceCwd(left);
  const b = normalizeWorkspaceCwd(right);
  return a !== undefined && b !== undefined && a === b;
}

function parentOf(node: DispatcherVisibilityNode): string | undefined {
  const parent = node.parentSessionId;
  return typeof parent === "string" && parent !== "" ? parent : undefined;
}

/**
 * The shared visibility rule. See the module doc for the full statement.
 */
export function canSeeDispatcherPeer(
  viewer: DispatcherVisibilityNode,
  target: DispatcherVisibilityNode,
): boolean {
  if (viewer.sessionId === target.sessionId) return false;

  const viewerParent = parentOf(viewer);
  const targetParent = parentOf(target);

  if (viewerParent === undefined) {
    if (viewer.marked === true) {
      // Unknown lineage: a marked parentless session is not a root. It may
      // only see its own direct children; root peers and siblings are hidden.
      return targetParent === viewer.sessionId;
    }
    // Root viewer.
    if (targetParent === undefined) {
      // A marked parentless target is not a root peer; its lineage is unknown.
      if (target.marked === true) return false;
      // Root ↔ root: the workspace is the only shared context.
      return sameWorkspace(viewer.cwd, target.cwd);
    }
    // A direct child team leader. Grandchildren are not visible.
    return targetParent === viewer.sessionId;
  }

  // Team-leader viewer: parent, sibling, or own direct child.
  if (target.sessionId === viewerParent) return true;
  if (targetParent === undefined) return false;
  return targetParent === viewerParent || targetParent === viewer.sessionId;
}
