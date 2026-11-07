# 236 — Racoons canonical encoder drops an own `__proto__` JSON member

**Status:** resolved
**Labels:** needs-triage
**Severity:** P2 / medium
**Ship blocker:** No

## Requirement / API contract

The public `canonicalBytesWithByteArrays` API must preserve own JSON members of accepted plain objects while normalizing byte arrays. Distinct JSON objects must retain their data distinctions in the resulting canonical bytes: `JSON.parse('{"__proto__":1}')` must not encode identically to `{}`. Ordinary keys and the existing byte-array conversion must continue to work.

The helper is publicly exported from [core/index.ts:25–28](../../vendor/racoons/core/index.ts#L25-L28). Its plain-object acceptance and own-key traversal are visible in [core/util/bytes.ts:77–85](../../vendor/racoons/core/util/bytes.ts#L77-L85); this requirement concerns the accepted JSON data, rather than a host security guarantee.

## Problem and evidence

`canonicalBytesWithByteArrays(JSON.parse('{"__proto__":1}'))` silently produces the same bytes as `canonicalBytesWithByteArrays({})`. The scalar own member is lost during the intermediate object copy.

- [core/util/bytes.ts:62–85](../../vendor/racoons/core/util/bytes.ts#L62-L85) calls `replaceByteArrays` before canonical serialization. The function accepts plain objects, creates `output` as `{}` at line 82, traverses `Object.keys(source)` at line 83, and assigns `output[key]` at line 84. For the own key `__proto__`, that assignment invokes the inherited setter instead of creating an own data property; the scalar value `1` leaves no corresponding own member on `output`.
- The shipped JavaScript has the same path at [core/lib/util/bytes.js:50–75](../../vendor/racoons/core/lib/util/bytes.js#L50-L75): plain-object acceptance at lines 66–68, `{}` at line 71, own-key traversal at line 72 and assignment at line 73. The recorded reproduction imports this shipped helper.
- `JSON.parse` supplies a real own JSON member named `__proto__`; the reproduction does not rely on an object literal's special prototype syntax. The ordinary-key control encodes as `{"normal":1}`.

**Evidence provenance:** separate source reviewer `677c34eb` confirmed the source mechanism and public export. Separate validator `d4262a10` supplied the successful reproduction and control below, with the launch history recorded explicitly. This ticket-writing pass confirmed only the cited source lines and performed the required tracker checks; it did not rerun the reproduction.

## Impact and limits

P2 / medium correctness defect: the public canonical encoder loses an accepted own JSON member and collapses two distinct JSON objects to identical bytes. Callers relying on those bytes to distinguish JSON data can lose that distinction. The recorded evidence establishes the utility-level collision and a normal-key control; it does not demonstrate a host integrity bypass or an end-to-end host exploit. Ship blocker: No.

## Recorded reproduction

Validator `d4262a10` recorded two Node launches. An earlier `node -e` attempt failed with a `SyntaxError` caused by PowerShell quoting before import, so it never reached the encoder. Only the successful launch below reached the encoder: a PowerShell single-quoted here-string piped to Node ESM, run from the repository root. This is the existing recorded recipe, not a rerun during ticket writing.

```powershell
@'
import { canonicalBytesWithByteArrays as encode } from './vendor/racoons/core/lib/util/bytes.js';
const decode = value => new TextDecoder().decode(encode(value));
const proto = decode(JSON.parse('{"__proto__":1}')), empty = decode({}), normal = decode(JSON.parse('{"normal":1}'));
console.log(JSON.stringify({proto, empty, normal, collision: proto === empty, normalPreserved: normal === '{"normal":1}'}));
process.exitCode = proto === empty && normal === '{"normal":1}' ? 0 : 1;
'@ | node --input-type=module
```

Exact recorded stdout (one JSON line):

```json
{"proto":"{}","empty":"{}","normal":"{\"normal\":1}","collision":true,"normalPreserved":true}
```

Exit code: `0`. Stderr was empty. The command deliberately exits 0 when the collision is present and the normal-key control is preserved; this result confirms the defect and control, rather than successful preservation of the `__proto__` member.

## Duplicate check

Rechecked `open`, `deferred`, `resolved` and `cancelled` on 2026-11-07 before creation. The all-status `Issue-tracker/**/236*` filename check returned no files; ID 236 was unused. A final ID guard was also performed immediately before exclusive file creation.

The direct root search covered `__proto__`, `prototype`, `canonicalBytesWithByteArrays` and canonical key/loss/collision wording. The expanded search also covered Chinese variants (`规范化`, `规范`, `标准化`, `确定性`, `原型`, `键`, `属性`, `丢失`, `遗漏`, `碰撞`, `冲突`, `序列化`), the `output[key] =` assignment mechanism, `Object.keys`, `Object.getPrototypeOf` and inherited-setter wording. All four statuses were searched separately; open, deferred and cancelled had no matches.

The direct terms matched only [resolved 170](../resolved/170-prompt-pass-dead-end-reporting-and-start-ack.md#L1), whose full text concerns prompt wording and a prototype project's reporting rules. The broader mechanism search additionally found incidental `Object.keys` mentions in [resolved 163:81–83](../resolved/163-ticket-157-four-implementation-defects.md#L81-L83), concerning missing dispatcher `meta.cwd`, and [resolved 84:91–101](../resolved/84-client-shell-mount-reads-sessions-layout-without-inject-host-throws-launcher-open-dead.md#L91-L101), concerning undeclared service injection. Their relevant context was reviewed. None concerns canonical encoding or the inherited-setter loss of an own `__proto__` member; no same-root duplicate was found.

## Acceptance criteria

- [ ] Accepted plain JSON objects preserve their own JSON keys and values, including the scalar member in `JSON.parse('{"__proto__":1}')`; its canonical JSON retains `{"__proto__":1}`.
- [ ] That input and `{}` encode to distinct bytes.
- [ ] Ordinary keys remain preserved, including `{"normal":1}`, with existing canonical ordering behavior retained.
- [ ] Existing byte-array behavior remains intact: `Uint8Array` values still normalize to their element arrays, including within arrays and plain objects.
- [ ] The TypeScript source and shipped JavaScript agree on these behaviors.

## Comments

- 2026-11-07 — Audit ticket created from separate source reviewer `677c34eb` and validator `d4262a10` evidence. Recorded both Node launches, identifying the initial pre-import quoting failure and the sole successful launch that reached the encoder, along with its exact stdout, exit 0 and empty stderr. P2 / medium; ship blocker: No; no demonstrated host integrity bypass. Ticket-writing only: no new tests, probes, builds, reference-tree reads or runtime evidence gathering, and no reproduction rerun. No implementation, configuration, other documentation or tracker index was changed.

## Resolution - 2026-11-08

Fixed in `34e1c17`: `replaceByteArrays` copies into a null-prototype object so an own `__proto__` member survives canonical encoding; `test/racoons-canonical-bytes.test.ts` passes 3/3.
