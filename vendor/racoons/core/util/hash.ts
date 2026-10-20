import { createHash } from "node:crypto";

export async function sha256(bytes: Uint8Array): Promise<string> {
  return sha256Sync(bytes);
}

export function sha256Sync(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
