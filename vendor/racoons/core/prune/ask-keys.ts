/**
 * The answer text's own structure, before any JSON library sees it
 * (ISSUE-022 chunk 3; ADR-0009).
 *
 * `JSON.parse` silently keeps the last of two equal keys, and a duplicated index
 * must keep its unit. So the batch ask reads the top-level keys of the answer
 * text itself: this module scans one JSON object's key list without building a
 * second parser for the values, which the wire parser already owns.
 *
 * Everything here is total: a text that is not one object yields `null` keys,
 * never a throw.
 */

/** "1", "2", … but never "0", "01", "1.5" or a number past the safe range. */
export function canonicalIndex(key: string): number | null {
  if (!/^[1-9][0-9]*$/u.test(key)) return null;
  const index = Number(key);
  return Number.isSafeInteger(index) ? index : null;
}

/** Canonical indices first in numeric order, then the rest in code-unit order. */
export function orderedKeys(record: Record<string, unknown>): readonly string[] {
  return Object.keys(record).sort((left, right) => {
    const leftIndex = canonicalIndex(left);
    const rightIndex = canonicalIndex(right);
    if (leftIndex !== null && rightIndex !== null) return leftIndex - rightIndex;
    if (leftIndex !== null) return -1;
    if (rightIndex !== null) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * The top-level keys of one JSON object text, in order, or `null` when the text
 * is not exactly one object. Values are skipped, not decoded: a string is
 * skipped to its closing quote, a nested object or array to its matching close,
 * and a scalar to its delimiter.
 */
export function topLevelKeys(text: string): readonly string[] | null {
  let at = 0;
  const space = (): void => {
    while (at < text.length && /\s/u.test(text[at] ?? "")) at += 1;
  };
  const quoted = (): string | null => {
    if (text[at] !== '"') return null;
    let escaped = false;
    for (let end = at + 1; end < text.length; end += 1) {
      if (escaped) escaped = false;
      else if (text[end] === "\\") escaped = true;
      else if (text[end] === '"') {
        const value = JSON.parse(text.slice(at, end + 1)) as string;
        at = end + 1;
        return value;
      }
    }
    return null;
  };
  const skipValue = (): boolean => {
    space();
    if (text[at] === '"') return quoted() !== null;
    if (text[at] !== "{" && text[at] !== "[") {
      const start = at;
      while (at < text.length && !/[\s,\]}]/u.test(text[at] ?? "")) at += 1;
      return at > start;
    }
    let depth = 0;
    let inString = false;
    for (; at < text.length; at += 1) {
      const char = text[at];
      if (inString) {
        if (char === "\\") at += 1;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{" || char === "[") depth += 1;
      else if ((char === "}" || char === "]") && --depth === 0) {
        at += 1;
        return true;
      }
    }
    return false;
  };

  space();
  if (text[at] !== "{") return null;
  at += 1;
  space();
  const keys: string[] = [];
  if (text[at] === "}") return keys;
  for (;;) {
    space();
    const key = quoted();
    if (key === null) return null;
    keys.push(key);
    space();
    if (text[at] !== ":") return null;
    at += 1;
    if (!skipValue()) return null;
    space();
    if (text[at] === ",") {
      at += 1;
      continue;
    }
    return text[at] === "}" ? keys : null;
  }
}
