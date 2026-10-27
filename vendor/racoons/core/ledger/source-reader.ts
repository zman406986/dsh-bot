import { readFile } from "node:fs/promises";
import type { Bytes, RecallId } from "../types/identity.js";
import { sha256 } from "../util/hash.js";
import { hasCode, storageError } from "./integrity.js";
import type { RecallManifest } from "./manifest.js";
import type { LedgerSourceReader, SourceFallbackRequest } from "./types.js";
import { LedgerError } from "./types.js";

/**
 * One recall the source index can still answer: the manifest its id names and
 * the file each of its parts came from. `paths` holds one path per manifest
 * part, in part order; the removed ranges and the content hash ride on the
 * manifest, so this record is exactly the "path + ranges + content hash" PRD
 * §6.7 stores for file-derived content.
 */
export interface IndexedRecall {
  readonly recallId: RecallId;
  readonly manifest: RecallManifest;
  readonly paths: readonly string[];
}

/**
 * The lookup half of a recall miss (ISSUE-045 chunk C7). `ledger/types.ts`
 * declares the reader's one call, `read(request)`, and that file is outside
 * this chunk's wall, so the index rides the same injected object: a reader that
 * also exposes `locate` can answer a miss, and one that exposes only `read`
 * answers nothing — its bytes name no path and no expected hash, so using them
 * would be a guess. The ledger asks for the lookup here, never through a global.
 */
export interface IndexedSourceReader extends LedgerSourceReader {
  locate(id: RecallId): IndexedRecall | null;
}

/** The reader as an index-bearing reader, or `null` when it carries no lookup. */
export function asIndexedSourceReader(reader: LedgerSourceReader): IndexedSourceReader | null {
  const candidate = reader as Partial<IndexedSourceReader>;
  return typeof candidate.locate === "function" ? reader as IndexedSourceReader : null;
}

/**
 * The file-backed source index. It holds the facts a host kept per recall id
 * and reads a part's original bytes back from disk; nothing here caches bytes,
 * so a recall answered from the source reads the file as it is now.
 *
 * `read` hashes the exact buffer it returns and compares it with the record's
 * `source.sha256`. A file edited after the record was minted — even one edited
 * to the same length — is a refusal, never a substitute (PRD §6.7, the
 * two-device safety rule): a caller asks for one provable byte string and gets
 * either that string or an error. The request's `ranges` are the manifest's
 * removed spans; `read` proves the whole body, and the recall proves every span
 * against the same buffer, so neither end trusts the index's own arithmetic.
 */
export class FileSourceReader implements IndexedSourceReader {
  readonly #recalls: ReadonlyMap<RecallId, IndexedRecall>;

  constructor(recalls: readonly IndexedRecall[]) {
    const index = new Map<RecallId, IndexedRecall>();
    for (const recall of recalls) {
      // Two facts for one id would make the answer depend on insertion order.
      if (index.has(recall.recallId)) {
        throw new LedgerError("hash-mismatch", `Two source records for ${recall.recallId}`);
      }
      index.set(recall.recallId, recall);
    }
    this.#recalls = index;
  }

  locate(id: RecallId): IndexedRecall | null {
    return this.#recalls.get(id) ?? null;
  }

  async read(request: SourceFallbackRequest): Promise<Bytes> {
    let bytes: Bytes;
    try {
      bytes = new Uint8Array(await readFile(request.path));
    } catch (error) {
      if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) {
        throw new LedgerError("not-found", `Missing source file ${request.path}`, { cause: error });
      }
      throw storageError(error, `Cannot read source file ${request.path}`);
    }
    // Hash the buffer just returned, never the path a second time: a file edited
    // between two reads cannot pass this check. The request's `ranges` are the
    // manifest's own removed spans; the caller proves every slice against this
    // same buffer, so this check needs no second copy of the range arithmetic.
    if (bytes.byteLength !== request.source.byteLength ||
        await sha256(bytes) !== request.source.sha256) {
      throw new LedgerError("hash-mismatch", `Source file changed: ${request.path}`);
    }
    return bytes;
  }
}
