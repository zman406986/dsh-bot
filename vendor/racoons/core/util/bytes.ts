const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function toBytes(s: string): Uint8Array {
  return encoder.encode(s);
}

export function fromBytes(b: Uint8Array): string {
  return decoder.decode(b);
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function sliceBytes(
  bytes: Uint8Array,
  startByte: number,
  endByteExclusive: number = bytes.byteLength,
): Uint8Array {
  if (
    !Number.isSafeInteger(startByte) ||
    !Number.isSafeInteger(endByteExclusive) ||
    startByte < 0 ||
    endByteExclusive < startByte ||
    endByteExclusive > bytes.byteLength
  ) {
    throw new RangeError("Byte slice bounds must be integers within the source.");
  }
  return Uint8Array.from(bytes.subarray(startByte, endByteExclusive));
}

export function byteLengthOf(value: string | Uint8Array): number {
  return typeof value === "string" ? toBytes(value).byteLength : value.byteLength;
}

export function canonicalManifestBytes(input: unknown): Uint8Array {
  return toBytes(encodeCanonical(input, new Set<object>()));
}

/**
 * Canonical bytes for values that carry raw byte leaves (application bodies,
 * evidence records). Byte arrays become number arrays; every other JSON value
 * is encoded by `canonicalManifestBytes`. The one implementation for the guard
 * and the ledger, so a hash never depends on which module produced it.
 */
export function canonicalBytesWithByteArrays(input: unknown): Uint8Array {
  return canonicalManifestBytes(replaceByteArrays(input, new Set<object>()));
}

function replaceByteArrays(value: unknown, ancestors: Set<object>): unknown {
  if (value instanceof Uint8Array) return Array.from(value);
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) {
    throw new TypeError("Canonical values must not contain cycles.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item: unknown) => replaceByteArrays(item, ancestors));
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical values must be plain objects.");
    }
    const source = value as Record<string, unknown>;
    // A null prototype keeps an own `__proto__` key an own key: on `{}` the
    // assignment below would hit the inherited setter and drop the member.
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      output[key] = replaceByteArrays(source[key], ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function encodePrimitive(value: string | number | boolean): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Manifest value cannot be encoded as JSON.");
  }
  return encoded;
}

function ownDataValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError("Manifest properties must contain values, not accessors.");
  }
  const value: unknown = descriptor.value;
  return value;
}

function encodeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return encodePrimitive(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Manifest numbers must be finite.");
    }
    return encodePrimitive(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("Manifest values must be plain JSON data.");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Manifest values must not contain cycles.");
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError("Manifest keys must be strings.");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      if (Object.keys(items).length !== items.length) {
        throw new TypeError("Manifest arrays must be dense and have no extra keys.");
      }
      const encoded: string[] = [];
      for (let index = 0; index < items.length; index += 1) {
        encoded.push(encodeCanonical(ownDataValue(items, String(index)), ancestors));
      }
      return `[${encoded.join(",")}]`;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Manifest objects must be plain objects.");
    }
    // Write sorted keys directly. JSON.stringify would reorder integer-like keys.
    const entries = Object.keys(value).sort().map((key) => {
      const encoded = encodeCanonical(ownDataValue(value, key), ancestors);
      return `${encodePrimitive(key)}:${encoded}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
