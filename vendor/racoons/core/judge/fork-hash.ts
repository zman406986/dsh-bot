/**
 * The fork's canonical hashes (ISSUE-026, ADR-0010).
 *
 * Every hash the fork asserts is defined here, once:
 * `sha256Sync(canonicalManifestBytes(...))`, the repo's one definition of bytes.
 * `hashWireRequest` is the seed hash — exactly `{system, tools, messages}` and
 * nothing else, so bookkeeping keys on the caller's object neither enter the
 * hash nor make a fork hash differently from the request it was seeded from.
 * The three component hashes are what the append seam re-checks: the system
 * bytes, the tool list, and one message at a time.
 *
 * The parameters are structural wire fields, not the fork's own interfaces, so
 * this module stays pure data in, pure hex out, and imports nothing from the
 * fork that imports it.
 */

import type { Sha256 } from "../types/identity.js";
import { canonicalManifestBytes } from "../util/bytes.js";
import { sha256Sync } from "../util/hash.js";

/** The fields a wire request hashes over. Extra keys are not read. */
export interface WireRequestFields {
  readonly system: string;
  readonly tools: readonly unknown[];
  readonly messages: readonly unknown[];
}

/** The seed hash: main's last sent request, canonicalized over its three fields. */
export function hashWireRequest(fields: WireRequestFields): Sha256 {
  return sha256Sync(canonicalManifestBytes({
    system: fields.system,
    tools: fields.tools,
    messages: fields.messages,
  }));
}

/** The system bytes alone, re-asserted before every append. */
export function hashSystem(system: string): Sha256 {
  return sha256Sync(canonicalManifestBytes(system));
}

/** The tool list alone, re-asserted before every append. */
export function hashTools(tools: readonly unknown[]): Sha256 {
  return sha256Sync(canonicalManifestBytes(tools));
}

/** One message, by index, recorded at append time and re-asserted later. */
export function hashMessage(message: unknown): Sha256 {
  return sha256Sync(canonicalManifestBytes(message));
}

/** One hash per message, in order. */
export function hashMessages(messages: readonly unknown[]): readonly Sha256[] {
  return messages.map(message => hashMessage(message));
}
