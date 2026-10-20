import type { Bytes, Sha256 } from "../types/identity.js";

export interface BlobStore {
  put(bytes: Bytes): Promise<Sha256>;
  get(hash: Sha256): Promise<Bytes>;
}
