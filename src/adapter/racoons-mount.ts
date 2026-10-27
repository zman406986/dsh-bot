/**
 * RACOONS mount glue (ticket 145): the ONE host seam between dsh-bot and the
 * vendored racoons library.
 *
 * Everything below uses PUBLIC exports only:
 *   - `racoons-dsh` / `racoons-dsh/plugin`: `createRacoonsPlugin`,
 *     `registerPluginTools`, `resolveSessionStorage`, `defaultStorageRoot`,
 *     `DshToolHost` and the host-facing types;
 *   - `@racoons/core`: the durable ledger pair (`SqliteLedger` +
 *     `FileBlobStore`) and the `Ledger` / `RecallRecord` types.
 *
 * Why the library's own `openLedger` is not imported: upstream exports it from
 * `storage.ts`, but the package publishes only `"."` and `"./plugin"`, and
 * `"./plugin"` re-exports `resolveSessionStorage`, `resolveStorage`,
 * `defaultStorageRoot` and the storage error types — NOT `openLedger`. The
 * mount's `openLedger` factory option IS public, so dsh-bot opens the same
 * per-session target the library would (`<root>/sessions/<id>/ledger.sqlite`
 * plus a sibling `blobs/`) through the core's public durable pair. The on-disk
 * layout is therefore identical to the pure product path.
 *
 * The mount is unconditional and has no session filter: it registers on the
 * plugin's own context, so the dispatcher session, every worker session and
 * every plain chat are all covered.
 *
 * The built-in global recall registration is suppressed by handing the mount a
 * NO-OP `DshToolHost` (`options.tools`). The built-in handler picks "the one
 * live session, or the first entry", which is wrong for a process hosting
 * several sessions at once. Recall is registered per session instead, through
 * `recallTools` (a surface the caller registers on) or `recallToolDefs` (the
 * same definition, captured for a surface the caller registers itself — the
 * worker composition path).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { FileBlobStore, SqliteLedger } from "@racoons/core";
import type { Clock, Ledger, RecallId, RecallRecord } from "@racoons/core";
import type { DshToolHost } from "racoons-dsh";
import {
  createRacoonsPlugin,
  defaultStorageRoot,
  registerPluginTools,
  resolveSessionStorage,
} from "racoons-dsh/plugin";
import type {
  DshLlmService,
  DshMountContext,
  RacoonsEnforcement,
  RacoonsJournalRecord,
  RacoonsPluginConfig,
} from "racoons-dsh/plugin";

/**
 * The structural slice of dsh-bot's Cordis context this glue drives. Narrow on
 * purpose: the plugin's `CordisContext` satisfies it, and a test stub with only
 * `on`/`effect`/`get` satisfies it too.
 */
export interface RacoonsHostContext {
  on(name: string, callback: (...args: never[]) => unknown): unknown;
  /** Guarded service read (`ctx.get`); absent on minimal stubs. */
  get?(name: string): unknown;
}

/** The mount options the plugin maps its volatile config onto. */
export interface RacoonsMountOptions {
  /**
   * `record-only` records answers and holds back the bulk prune and manual
   * forget; an entry checkpoint's own answer still applies (`apply` is the
   * default).
   */
  readonly enforcement: RacoonsEnforcement;
  /** Durable root; absent means the library default (`<DSH_HOME>/storages/racoons`). */
  readonly racoonsStorageRoot?: string;
  /** Half-window auto-prune denominator; `null` disables the trigger. */
  readonly contextWindowTokens?: number | null;
}

/** A tool surface that accepts a host-shaped definition (scoped or plugin-level). */
export interface RacoonsRecallToolSurface {
  register?(definition: unknown): () => void;
}

/**
 * The live mount handle. `dispose()` releases every listener the mount added
 * and closes every cached ledger (the mount skips host-owned ledgers by
 * design, so this is the only place they close).
 */
export interface RacoonsMountHandle {
  /**
   * The already-open ledger for one session. Throws honestly when the mount has
   * not opened it: a recall id cannot exist for a session whose ledger never
   * opened.
   */
  ledgerOf(sessionId: string): Ledger;
  /** Get-or-open that session's ledger; the recall handler uses this. */
  ledgerFor(sessionId: string): Promise<Ledger>;
  /** One session's recall function, reading only that session's ledger. */
  recallFor(sessionId: string): (id: string) => Promise<RecallRecord>;
  /**
   * Register the recall tool on ONE session's tool surface. Returns the exact
   * unregister, so a deactivation releases the name.
   */
  recallTools(surface: RacoonsRecallToolSurface | undefined, sessionId: string): () => void;
  /**
   * The same recall tool DEFINITION, captured instead of registered, for a
   * surface the caller wires itself (the worker composition path). Built by
   * the library's own `registerPluginTools`, so the definition can never drift
   * from the shipped one.
   */
  recallToolDefs(sessionId: string): readonly unknown[];
  /** Release listeners and close every cached ledger. Idempotent. */
  dispose(): Promise<void>;
}

/** No-op tool host: suppresses the library's built-in global recall registration. */
const NOOP_TOOL_HOST: DshToolHost = Object.freeze({
  register: () => () => {},
});

/**
 * The mount's warning channel. `createRacoonsPlugin` already prefixes
 * `racoons: `, so a message that carries it is not double-prefixed.
 */
function warnLine(message: string): void {
  try {
    console.warn(message.startsWith("racoons:") ? message : `racoons: ${message}`);
  } catch {
    // A broken console must never break the mount.
  }
}

/**
 * The journal sink: one line per record, prefixed `racoons:`. This is the
 * evidence trail the live gate reads. A sink must never alter an engine
 * outcome, so a record that cannot be rendered degrades to its kind alone.
 */
export function createJournalSink(
  write: (line: string) => void = (line) => {
    console.info(line);
  },
): (record: RacoonsJournalRecord) => void {
  return (record) => {
    try {
      const fields: Record<string, unknown> = { ...record };
      delete fields["kind"];
      write(`racoons: ${record.kind} ${JSON.stringify(fields)}`);
    } catch {
      try {
        write(`racoons: ${record.kind}`);
      } catch {
        // Journaling only.
      }
    }
  };
}

/** One-time, guarded read of the host's model seam. */
function readLlm(ctx: RacoonsHostContext): DshLlmService | undefined {
  try {
    const value = ctx.get?.("llm");
    if (
      value !== null &&
      typeof value === "object" &&
      typeof (value as { stream?: unknown }).stream === "function"
    ) {
      return value as DshLlmService;
    }
  } catch {
    // An un-injected service throws on this context; that is "no llm", not a
    // mount failure.
  }
  return undefined;
}

/**
 * Build the `DshMountContext`-shaped adapter over dsh-bot's own context.
 *
 * `on` keeps the host's own disposer, and `effect` collects the mount's own
 * cleanup (the library registers `mount.close()` there), so `dispose()`
 * releases every listener AND runs the mount's own teardown. `get` never
 * throws on a missing service, and `tools` is the no-op host that suppresses
 * the library's global recall.
 */
function mountContextFor(
  ctx: RacoonsHostContext,
  offs: Array<() => void>,
  cleanups: unknown[],
): DshMountContext {
  const mountCtx: DshMountContext = {
    on(event, listener) {
      const off = ctx.on(event, listener as (...args: never[]) => void);
      if (typeof off === "function") offs.push(off as () => void);
      return off;
    },
    effect(register) {
      // Cordis semantics: `execute` runs now, what it returns is the unload
      // cleanup. The stub context need not supply `effect`; the mount gates on
      // it with `?.`.
      cleanups.push(register());
      return undefined;
    },
    logger: { warn: warnLine },
    tools: NOOP_TOOL_HOST,
    get(name) {
      try {
        return ctx.get?.(name);
      } catch {
        return undefined;
      }
    },
  };
  const llm = readLlm(ctx);
  if (llm !== undefined) mountCtx.llm = llm;
  return mountCtx;
}

/**
 * Mount racoons on the plugin context and return its handle.
 *
 * Storage: the root is the configured one, or the library default
 * (`<DSH_HOME>/storages/racoons`). Every ledger opens under
 * `<root>/sessions/<sessionId>/ledger.sqlite` with blobs in a sibling
 * `blobs/`, exactly as the library's own durable plan would place them.
 *
 * A failed open rejects; the mount's pre-step listener catches it and the next
 * step boundary retries (with a host-owned factory the mount installs no
 * refusing ledger — the failure stays the host's).
 */
export function createRacoonsMountHandle(
  ctx: RacoonsHostContext,
  options: RacoonsMountOptions,
): RacoonsMountHandle {
  const root = options.racoonsStorageRoot ?? defaultStorageRoot();
  const clock: Clock = { nowMs: () => Date.now() };
  const offs: Array<() => void> = [];
  /** What the mount's own `ctx.effect` registered, run at dispose. */
  const cleanups: unknown[] = [];
  const ledgers = new Map<string, Ledger>();
  const opening = new Map<string, Promise<Ledger>>();
  let disposed = false;

  async function openNow(sessionId: string): Promise<Ledger> {
    const target = resolveSessionStorage(root, sessionId);
    mkdirSync(dirname(target.databasePath), { recursive: true });
    mkdirSync(target.blobRoot, { recursive: true });
    const ledger = await SqliteLedger.open({
      databasePath: target.databasePath,
      blobStore: new FileBlobStore(target.blobRoot),
      clock,
    });
    if (disposed) {
      // A teardown raced this open: never leave a handle outside the map.
      await ledger.close().catch(() => {});
      throw new Error(`racoons: the mount for session ${sessionId} is disposed`);
    }
    ledgers.set(sessionId, ledger);
    return ledger;
  }

  function ledgerFor(sessionId: string): Promise<Ledger> {
    const known = ledgers.get(sessionId);
    if (known !== undefined) return Promise.resolve(known);
    const inFlight = opening.get(sessionId);
    if (inFlight !== undefined) return inFlight;
    const started = openNow(sessionId);
    opening.set(sessionId, started);
    // A transient failure clears the slot so the next boundary retries; a
    // success keeps it (a resolved promise is the cheapest cache).
    started.catch(() => {
      if (opening.get(sessionId) === started) opening.delete(sessionId);
    });
    return started;
  }

  function ledgerOf(sessionId: string): Ledger {
    const ledger = ledgers.get(sessionId);
    if (ledger === undefined) {
      throw new Error(
        `racoons: no ledger is open for session ${sessionId}; ` +
          "the session has not reached a step boundary since the mount started",
      );
    }
    return ledger;
  }

  /**
   * One session's recall function. Reads the session's OWN ledger and nothing
   * else, so a recall id minted in another session is answered `not-found` by
   * the ledger itself rather than leaking across sessions.
   *
   * `ledgerOf`, not `ledgerFor`: a recall can only name an archive that a
   * completed pass wrote, and that pass requires an open ledger. Reporting the
   * absence honestly is better than creating an empty ledger for a session
   * that never reached a boundary.
   */
  function recallFor(sessionId: string): (id: string) => Promise<RecallRecord> {
    return async (id: string) => ledgerOf(sessionId).recall(id as RecallId);
  }

  const config: RacoonsPluginConfig = {
    enforcement: options.enforcement,
    racoonsStorageRoot: root,
    contextWindowTokens: options.contextWindowTokens ?? null,
  };
  const plugin = createRacoonsPlugin({
    config,
    openLedger: ledgerFor,
    journal: createJournalSink(),
    tools: NOOP_TOOL_HOST,
  });
  // `apply` is async, but every registration in it lands before its first
  // await, so the listeners exist by the time this returns. A rejection is a
  // mount failure: log it, never throw into the host's apply.
  const applied = plugin.apply(mountContextFor(ctx, offs, cleanups), {});
  applied.catch((error: unknown) => {
    warnLine(`mount: ${error instanceof Error ? error.message : String(error)}`);
  });

  let disposing: Promise<void> | undefined;
  return {
    ledgerOf,
    ledgerFor,
    recallFor,
    recallToolDefs(sessionId) {
      const captured: unknown[] = [];
      registerPluginTools(
        {
          register: (definition) => {
            captured.push(definition);
            return () => {};
          },
        },
        { recall: recallFor(sessionId) },
      );
      return captured;
    },
    recallTools(surface, sessionId) {
      if (surface === undefined || typeof surface.register !== "function") {
        return () => {};
      }
      return registerPluginTools(
        { register: (definition) => (surface.register as (d: unknown) => () => void)(definition) },
        { recall: recallFor(sessionId) },
      );
    },
    dispose() {
      disposing ??= (async () => {
        disposed = true;
        for (const off of offs.splice(0).reverse()) {
          try {
            off();
          } catch {
            // Teardown only.
          }
        }
        // Let a mount that is still mid-apply finish before closing anything.
        await applied.catch(() => {});
        // The mount's own cleanup closes the ledgers it OWNS; with a host
        // factory it owns none, so this is mostly the tool-registration undo.
        for (const cleanup of cleanups.splice(0).reverse()) {
          try {
            if (typeof cleanup === "function") await (cleanup as () => unknown)();
          } catch {
            // Teardown only.
          }
        }
        const open = [...ledgers.values()];
        ledgers.clear();
        opening.clear();
        await Promise.all(open.map((ledger) => ledger.close().catch(() => {})));
      })();
      return disposing;
    },
  };
}

/**
 * The plugin-facing registration: mount racoons on `ctx` and return its
 * handle. `handle.dispose()` is the disposer Cordis collects (listeners off,
 * host-owned ledgers closed).
 */
export function registerRacoonsMount(
  ctx: RacoonsHostContext,
  options: RacoonsMountOptions,
): RacoonsMountHandle {
  return createRacoonsMountHandle(ctx, options);
}
