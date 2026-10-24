/**
 * The dsh adapter's storage seam (ADR-0013, ISSUE-004 chunk 2).
 *
 * The durable trash ledger lives in its own per-session SQLite file at
 * `<racoonsStorageRoot>/sessions/<sessionId>/ledger.sqlite`, with the blob
 * store in a sibling `blobs/` directory. It never shares a file with dsh's
 * own storage: RACOONS stamps its own `application_id` and `user_version`
 * (`packages/core/src/ledger/schema.ts`), so a shared file is unreadable by
 * both sides. `:memory:` stays allowed for tests only.
 *
 * The product path configures the storage ROOT only: every `databasePath` and
 * `blobRoot` is derived per session under it, so an explicit durable path pair
 * is refused (`explicit-storage-paths`) rather than silently shared across
 * sessions — one shared file would contradict ADR-0013 ruling 1. `':memory:'`
 * stays the test-only pair.
 *
 * A durable open failure is typed and carries the path. `sessionFor` consumes
 * it (ADR-0013 ruling 4, ISSUE-004 chunk 4): a transient failure is retried at
 * the next step boundary and only the final failure installs
 * `refusing-ledger.ts` and journals `storage-unavailable` once; this module
 * still propagates.
 *
 * `DOMAIN_VERSION` stays 2 (ADR-0013 ruling 5): no host-domain data is touched
 * because `hostDomain` is empty for this adapter, so RACOONS neither reads nor
 * bumps the host's version.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { FileBlobStore, MemoryBlobStore, SqliteLedger } from '@racoons/core';
import type { Clock, Ledger } from '@racoons/core';

/** The raw storage options a caller may pass to the plugin. */
export interface RacoonsStorageOptions {
  /**
   * The storage root; every session's ledger and blobs are derived under it.
   * `':memory:'` (tests only) selects the in-memory pair. A durable path pair
   * is NOT accepted — see `databasePath`/`blobRoot` on `ResolvedRacoonsStorage`.
   */
  readonly root?: string;
  /**
   * Test-only durable override, refused on the product path. Kept in the type so
   * a caller that passes the pair gets a typed refusal, not a silently ignored
   * field. `resolveStorage` throws `explicit-storage-paths` for any durable
   * value here.
   */
  readonly databasePath?: string;
  /** Test-only override; refused with `explicit-storage-paths` like `databasePath`. */
  readonly blobRoot?: string;
}

/**
 * A resolved storage target. `':memory:'` on both fields is the in-memory
 * pair; otherwise both are absolute paths. `root` is present only for the
 * per-session plan `resolveStorage` returns when a durable root is configured
 * — `sessionFor` refines it through `resolveSessionStorage` before opening.
 */
export interface ResolvedRacoonsStorage {
  readonly databasePath: string;
  readonly blobRoot: string;
  readonly root?: string;
}

export type RacoonsStorageErrorCode =
  | 'relative-root'
  | 'explicit-storage-paths'
  | 'invalid-session-id'
  | 'unresolved-session'
  | 'durable-open-failed'
  | 'open-retrying';

/** A storage refusal or failure. `path` names the value at fault, when one exists. */
export class RacoonsStorageError extends Error {
  readonly code: RacoonsStorageErrorCode;
  readonly path: string | null;

  constructor(code: RacoonsStorageErrorCode, message: string, path: string | null = null,
    options?: ErrorOptions) {
    super(message, options);
    this.name = 'RacoonsStorageError';
    this.code = code;
    this.path = path;
  }
}

/** How many times one session's durable open is attempted: the open, then one retry. */
export const STORAGE_OPEN_ATTEMPTS = 2;

/**
 * A durable open that failed once and will be retried at the next step boundary
 * (ISSUE-004 critic fix P2#4). It is not a refusal: the mount aborts this
 * pre-step without feeding the engine a ledger that cannot answer, journals a
 * warn, and tries again on the next session entry / step boundary. Only when the
 * retry also fails does the mount install the refusing ledger.
 */
export class RacoonsStorageRetryError extends RacoonsStorageError {
  readonly sessionId: string;
  readonly attempt: number;

  constructor(sessionId: string, attempt: number, failure: {
    readonly code: string; readonly path: string | null; readonly message: string;
  }) {
    super('open-retrying', `racoons: the durable ledger for session ${sessionId} did not open`
      + ` (attempt ${String(attempt)} of ${String(STORAGE_OPEN_ATTEMPTS)});`
      + ` retrying at the next step boundary: ${failure.message}`, failure.path);
    this.name = 'RacoonsStorageRetryError';
    this.sessionId = sessionId;
    this.attempt = attempt;
  }
}

/** The literal a durable path uses per session; never a usable directory name. */
export const SESSION_PLACEHOLDER = '<sessionId>';

const MEMORY_STORAGE: ResolvedRacoonsStorage = Object.freeze({
  databasePath: ':memory:', blobRoot: ':memory:',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The default durable root: `<DSH_HOME>/storages/racoons`. `DSH_HOME`
 * defaults to `~/.dsh` (`C:\Users\TZhen\.dsh` on one owner device,
 * `C:\Users\TZ\.dsh` on the other). The `storages` level is the dsh storage
 * root the rig also redirects (`dev/dsh-rig/run.mjs`); `racoons` is a
 * subdirectory, so no dsh file is ever shared.
 */
export function defaultStorageRoot(env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()): string {
  const configured = env['DSH_HOME'];
  const raw = typeof configured === 'string' && configured.trim() !== ''
    ? configured.trim() : join(home, '.dsh');
  // A relative DSH_HOME is read relative to the home directory, never the cwd:
  // the mount must not depend on where the host process was started.
  const dshHome = isAbsolute(raw) ? raw : join(home, raw);
  return join(dshHome, 'storages', 'racoons');
}

/**
 * Resolve raw storage options. The product path takes a storage ROOT and only a
 * root: every per-session path is derived under it, so a durable
 * `{databasePath, blobRoot}` pair is refused instead of becoming one ledger
 * shared by every session. `':memory:'` stays the test-only pair. Absent
 * options and no root resolve to the in-memory pair (tests).
 */
export function resolveStorage(raw: RacoonsStorageOptions | undefined,
  root?: string): ResolvedRacoonsStorage {
  const storage: RacoonsStorageOptions = isRecord(raw) ? raw : {};
  const databasePath = typeof storage.databasePath === 'string' ? storage.databasePath : undefined;
  const blobRoot = typeof storage.blobRoot === 'string' ? storage.blobRoot : undefined;
  if (databasePath === ':memory:') {
    if (blobRoot !== undefined && blobRoot !== ':memory:') {
      throw new RacoonsStorageError('explicit-storage-paths',
        "racoons: ':memory:' keeps blobs in memory; an explicit blobRoot would split the pair",
        blobRoot);
    }
    return MEMORY_STORAGE;
  }
  if (databasePath !== undefined) {
    throw new RacoonsStorageError('explicit-storage-paths',
      'racoons: an explicit databasePath would be one ledger shared by every session; '
      + 'pass a storage root and each session derives its own ledger there '
      + "(use ':memory:' for tests)", databasePath);
  }
  if (blobRoot !== undefined) {
    throw new RacoonsStorageError('explicit-storage-paths',
      'racoons: an explicit blobRoot would be one blob store shared by every session; '
      + 'pass a storage root and each session derives its own blobs there', blobRoot);
  }
  const configuredRoot = typeof storage.root === 'string' ? storage.root : root;
  if (configuredRoot === undefined) return MEMORY_STORAGE;
  if (!isAbsolute(configuredRoot)) {
    throw new RacoonsStorageError('relative-root',
      `racoons: racoonsStorageRoot must be an absolute path: ${configuredRoot}`, configuredRoot);
  }
  const sessionDir = join(configuredRoot, 'sessions', SESSION_PLACEHOLDER);
  return Object.freeze({
    databasePath: join(sessionDir, 'ledger.sqlite'),
    blobRoot: join(sessionDir, 'blobs'),
    root: configuredRoot,
  });
}

/**
 * The per-session target under a durable root. A session id is a directory
 * name here, so anything that could escape the root is refused, not rewritten.
 */
export function resolveSessionStorage(root: string, sessionId: string): ResolvedRacoonsStorage {
  if (sessionId === '' || sessionId === '.' || sessionId === '..'
    || /[\\/:]/u.test(sessionId) || sessionId.includes('\0')) {
    throw new RacoonsStorageError('invalid-session-id',
      `racoons: session id is not a safe directory name: ${JSON.stringify(sessionId)}`, sessionId);
  }
  const sessionDir = join(root, 'sessions', sessionId);
  return Object.freeze({
    databasePath: join(sessionDir, 'ledger.sqlite'),
    blobRoot: join(sessionDir, 'blobs'),
  });
}

/**
 * Open the ledger for one resolved target. Durable opens create the session
 * directory and the blob root first; a failure is a `RacoonsStorageError`
 * carrying the database path (ADR-0013: the caller, chunk 4, decides refusal).
 */
export async function openLedger(storage: ResolvedRacoonsStorage, clock: Clock): Promise<Ledger> {
  if (storage.databasePath === ':memory:') {
    return SqliteLedger.open({
      databasePath: storage.databasePath, blobStore: new MemoryBlobStore(), clock,
    });
  }
  if (storage.root !== undefined) {
    throw new RacoonsStorageError('unresolved-session',
      `racoons: storage plan for ${storage.root} must be refined per session before opening`,
      storage.root);
  }
  try {
    mkdirSync(dirname(storage.databasePath), { recursive: true });
    mkdirSync(storage.blobRoot, { recursive: true });
    return await SqliteLedger.open({
      databasePath: storage.databasePath, blobStore: new FileBlobStore(storage.blobRoot), clock,
    });
  } catch (error) {
    if (error instanceof RacoonsStorageError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new RacoonsStorageError('durable-open-failed',
      `racoons: cannot open the durable ledger at ${storage.databasePath}: ${reason}`,
      storage.databasePath, { cause: error });
  }
}
