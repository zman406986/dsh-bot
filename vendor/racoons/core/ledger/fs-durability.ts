import { closeSync, fsyncSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { hasCode } from "./integrity.js";

/**
 * fsync one closed file's contents. Renaming a file is atomic, but its bytes
 * are only guaranteed on media after fsync, so a rename that follows a write
 * is only as durable as that write.
 */
export function fsyncFile(path: string): void {
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * fsync a directory and each of its ancestors, so a rename or a new shard
 * itself survives a power cut.
 *
 * Windows does not expose directory fsync through node:fs. The file fsync
 * above is still mandatory; on platforms that support it, persist the rename.
 */
export function syncDirectoryChain(path: string): void {
  for (let current = path; ; current = dirname(current)) {
    syncDirectory(current);
    if (dirname(current) === current) return;
  }
}

function syncDirectory(path: string): void {
  let fd: number;
  try { fd = openSync(path, "r"); }
  catch (error) {
    if (process.platform === "win32" &&
        (hasCode(error, "EISDIR") || hasCode(error, "EPERM") || hasCode(error, "EACCES"))) return;
    throw error;
  }
  try { fsyncSync(fd); }
  catch (error) {
    if (!(process.platform === "win32" &&
        (hasCode(error, "EINVAL") || hasCode(error, "EPERM") || hasCode(error, "EBADF")))) throw error;
  } finally { closeSync(fd); }
}
