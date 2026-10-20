import type { Bytes, Sha256 } from "../types/identity.js";
import { sha256 } from "../util/hash.js";
import type { BlobStore } from "./blob-store.js";
import { assertHash, verifyBytes } from "./integrity.js";
import { LedgerError } from "./types.js";

export class MemoryBlobStore implements BlobStore {
  readonly #objects = new Map<Sha256, Bytes>();

  async put(bytes: Bytes): Promise<Sha256> {
    const copy = new Uint8Array(bytes);
    const hash = await sha256(copy);
    const existing = this.#objects.get(hash);
    if (existing !== undefined) await verifyBytes(existing, hash, copy.byteLength);
    else this.#objects.set(hash, copy);
    return hash;
  }

  async get(hash: Sha256): Promise<Bytes> {
    assertHash(hash);
    const bytes = this.#objects.get(hash);
    if (bytes === undefined) {
      throw new LedgerError("not-found", `Missing blob ${hash}`);
    }
    await verifyBytes(bytes, hash);
    return new Uint8Array(bytes);
  }
}
