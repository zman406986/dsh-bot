import {
  closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Bytes, Sha256 } from "../types/identity.js";
import { sha256 } from "../util/hash.js";
import type { BlobStore } from "./blob-store.js";
import { syncDirectoryChain } from "./fs-durability.js";
import { assertHash, hasCode, storageError, verifyBytes } from "./integrity.js";
import { LedgerError } from "./types.js";

export class FileBlobStore implements BlobStore {
  readonly #root: string;

  constructor(rootPath: string) {
    this.#root = resolve(rootPath);
  }

  async put(bytes: Bytes): Promise<Sha256> {
    const copy = new Uint8Array(bytes);
    const hash = await sha256(copy);
    const target = this.#path(hash);
    const temporaryRoot = join(this.#root, "temporary");
    let staging: string | undefined;
    let unpublished: string | undefined;
    let locked = false;
    const lock = join(temporaryRoot, `${hash}.lock`);
    try {
      mkdirSync(dirname(target), { recursive: true });
      mkdirSync(temporaryRoot, { recursive: true });
      if (existsSync(target)) {
        await this.#acceptExisting(hash, copy.byteLength);
        return hash;
      }
      staging = mkdtempSync(join(temporaryRoot, "publish-"));
      unpublished = join(staging, "body");
      const fd = openSync(unpublished, "wx");
      try {
        writeFileSync(fd, copy);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      // Serialize cooperating publishers across processes: rename alone replaces
      // existing files on POSIX. A crashed lock fails closed after a bounded wait.
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          mkdirSync(lock);
          locked = true;
          break;
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
          if (existsSync(target)) {
            await this.#acceptExisting(hash, copy.byteLength);
            return hash;
          }
          await new Promise<void>(done => setTimeout(done, 10));
        }
      }
      if (!locked) throw new LedgerError("storage", `Blob publication locked: ${hash}`);
      if (existsSync(target)) {
        await this.#acceptExisting(hash, copy.byteLength);
        return hash;
      }
      renameSync(unpublished, target);
      unpublished = undefined;
      syncDirectoryChain(dirname(target));
      return hash;
    } catch (error) {
      throw storageError(error, `Cannot publish blob ${hash}`);
    } finally {
      try {
        if (locked) rmdirSync(lock);
        if (unpublished !== undefined && existsSync(unpublished)) unlinkSync(unpublished);
        if (staging !== undefined) rmdirSync(staging);
      } catch (error) { throw storageError(error, "Cannot clean unpublished blob files"); }
    }
  }

  async get(hash: Sha256): Promise<Bytes> {
    assertHash(hash);
    try {
      const bytes = new Uint8Array(readFileSync(this.#path(hash)));
      await verifyBytes(bytes, hash);
      return bytes;
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        throw new LedgerError("not-found", `Missing blob ${hash}`, { cause: error });
      }
      throw storageError(error, `Cannot read blob ${hash}`);
    }
  }

  #path(hash: Sha256): string {
    assertHash(hash);
    return join(this.#root, "sha256", hash.slice(0, 2), hash.slice(2));
  }

  async #acceptExisting(hash: Sha256, length: number): Promise<void> {
    await verifyBytes(await this.get(hash), hash, length);
    // Another publisher fsynced the body before renaming it, but may not yet
    // have flushed its shard. Do that here before accepting its publication.
    syncDirectoryChain(dirname(this.#path(hash)));
  }
}
