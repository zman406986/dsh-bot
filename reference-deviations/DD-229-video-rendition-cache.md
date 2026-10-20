# DD-229 — Video playback rendition cache (probe, transcode, LRU, refcount)
- **Area:** A25 attachments & media
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does
The reference's attachments extension carries a video **playback rendition cache** — a support mechanism whose only purpose is that a video the user attached can actually be watched in the reference's own player.

The flow, on a read of an attached video: probe the source with an external **media prober** for the first video stream's codec name; if the codec is anything other than the one the playback path cannot handle (the probe result is compared against a single unsupported codec), hand back the original path unchanged and do no work at all. Only for that one unsupported codec does it produce a rendition, by running an external **media transcoder** to re-encode the video stream to a widely supported codec plus an audio stream, writing to a temp file in a per-process temp directory and then renaming it into place atomically (so a partially written rendition is never visible under its final name). The prober and transcoder are the two well-known third-party command-line tools; the reference names them literally at `video-playback-rendition.ts:19` and `:23`, and the file header at `:7`–`:9` fixes the tool timeout at two minutes, the cache bound at eight renditions, and a failed-resolution retry interval of thirty seconds.

The interesting part is the cache rules wrapped around that:
- **Bounded LRU, keyed on source identity.** The map is keyed by a hash of the source path plus its size and mtime (`:28`), so an edited source naturally misses. Insertion order is used as recency order — a hit re-inserts the entry to move it to the newest position (`:30`) — and after any insert the map is trimmed while its size exceeds the bound of eight (`:31`).
- **Reader refcounting.** The resolution record carries an active-reader count; the reader callback is invoked inside a try/finally that increments on entry and decrements on exit (`:32`), so the count is released even when the read throws.
- **Eviction deferred under a reader.** Trimming never deletes a rendition file directly. It marks the record evicted and hands it to a helper that returns immediately unless the record is evicted *and* the active-reader count is zero; only then does it await the resolution promise and remove the file (`:15`). A rendition in use is therefore never pulled out from under its reader — it is released when the reader finishes, because the reader's own finally block re-runs the same helper (`:32`).
- **Retry of a failed resolution rather than a leak.** When the transcode promise resolves to nothing, the record gets a retry timestamp thirty seconds out; a later lookup that finds an expired timestamp deletes the record, marks it evicted, and starts fresh (`:31`), so a transient tool failure does not permanently break the source.
- **Bounded transcode concurrency.** At most two transcodes run at once, with a queue of waiters released in order (`:13`–`:14`), so the cache cannot spawn an unbounded number of encoder processes.

Callers reach it through a wrapper that takes the source path and a read callback, resolves the rendition, and passes the *resolved* path to the callback (`:27`). The attachments service wires it into its chunked video read path only — a non-video read goes through the plain reader — at `attachments-service.ts:206`–`:211`, and imports the wrapper at `:20`.

## What the current build does
**Absent.** The build has no media probing, no transcoding, and no rendition cache. A scan of all 72 TypeScript files under `src/` and `client/` finds no occurrence of either media tool's name, no transcode vocabulary, no encoder or codec settings, and no temporary-rendition or temp-directory management of any kind. There is nothing to cache and nothing to evict.

The build also does not render video at all, which is the reason for that absence rather than an accident of coverage:
- The deliver tool forwards attachment **path strings** and never touches the bytes: `src/core/tools.ts:567`–`:590` declares an optional list of local paths and passes them through to the injected user-send, with the comment at `:571` that they are never auto-attached (DD-198, attachment upload lifecycle).
- The content-block view is **text-only**: `src/adapter/content-blocks.ts:7`–`:18` defines a text block and treats every other block kind as opaque, and `:31`–`:41` concatenates only text blocks — so an image or video block passing through is an unread passthrough (DD-201, model-boundary image handling; DD-202, attachment kind classification).
- The client surface carries attachments as **opaque values**: the command transaction at `src/client/context.ts:323`–`:331` types them as a readonly array of unknowns, with no media handling on the client side.

## The deviation
The reference has a playback-support mechanism for a player it owns; the build has no player. Its attachment handling is a pass-through — paths in, paths out — and the host renders. So the mechanism has **nothing to act on** in the build: there is no rendition to produce, no reader to protect, and no cache to bound.

Two ideas inside the mechanism are nevertheless general and worth naming as the transferable part, because neither is really about video:
- **(a) An LRU with refcounting** — a bounded, recency-ordered cache whose entries are not evicted while a reader holds them, with release on the reader's exit path. This is a rule about resource lifetime, not a media concern; it applies to any disk-backed artifact that is expensive to produce and read concurrently.
- **(b) Retry of a failed eviction/resolution** — a record whose production failed is marked for retry on a timer and cleaned up later, rather than silently retained or left to leak. Again general.

The display part — a video the user attached being watchable inside the product — belongs to the rich-chat ergonomics group: ADR-0018 exception **U-B** rules out "rich attachment viewers" among other ergonomics. That exception governs *display*, not resource management, so it is cited for the playback part only; it says nothing about LRU bounds, refcounts, or eviction retries.

## Verdict: DO-NOT-INCORPORATE
The playback part is decided, not merely unattractive: ADR-0018 exception U-B rules out rich attachment viewers, so a rendition cache whose whole purpose is to make an attached video watchable in the product's own viewer is out by a recorded ruling — and independently, it has nothing to act on in a pass-through architecture where the host renders and the build only forwards paths (DD-198, DD-201). The second part — the resource-lifetime mechanism: a bounded LRU with refcounted lifetime and a retry on a failed resolution — is **not covered by any recorded ruling**; U-B governs display, not resource management, so it is unruled rather than forbidden, and it is recorded here as transferable rather than dismissed. But it too has no consumer today: with nothing cached and nothing rendered, there is no in-use artifact to protect and no eviction to retry. The verdict is therefore not to incorporate now, and to leave the two transferable ideas on the record for whoever first introduces a cached, refcounted, disk-backed artifact.

## Incorporation notes
- **Where it would live:** Nothing today. The playback part would belong to a client/viewer surface that does not exist (the build has no player; `client/` holds a thin surface, and `src/adapter/content-blocks.ts` is deliberately text-only). The second part — the resource-lifetime mechanism — would belong wherever a bounded, disk-backed, reader-shared artifact first appears — no such owner exists in `src/core/`, `src/adapter/`, `src/client/`, or `src/worker/`.
- **Constraints:** (1) U-B forbids the display part — do not build a viewer to justify the cache. (2) The general mechanism must be re-derived as a general resource-lifetime utility, not transplanted as video code: no media tool invocation, no codec vocabulary, no temp-directory layout copied from the reference. (3) Bounded concurrency and a tool timeout are part of the reference's rules but are meaningless without the tools; do not carry them over speculatively.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — the general mechanism itself is small (a bounded LRU, a refcount released on the exit path, a deferred-eviction helper, a retry timestamp), but it has no owner in the build today, so the real cost is the missing consumer rather than the code; building it now would create an abstraction nothing uses.
- **Key reference anchors:** the reference tree's `source/host/extensions/attachments/video-playback-rendition.ts` — `:7`–`:9` limits (tool timeout, cache bound of eight, thirty-second retry), `:10` per-process temp cache directory, `:11`–`:12` the resolution record and the source-keyed map, `:13`–`:14` bounded transcode concurrency with an ordered waiter queue, `:15` the deferred-eviction helper (evicted AND zero readers), `:16` the tool runner, `:17` the rendition-presence check, `:18`–`:26` probe-then-transcode with temp-file-then-rename, `:27`–`:33` the reader wrapper (source hash key, LRU re-insert on hit, trim loop, refcount try/finally, retry timestamp). Caller: the reference tree's `source/host/extensions/attachments/attachments-service.ts:20` (import) and `:206`–`:211` (chunked video read path; the non-video path bypasses the wrapper).

## Evidence
- Reference:
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/attachments/video-playback-rendition.ts` (34 lines; the whole mechanism).
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/attachments/attachments-service.ts` lines 20, 205–211 (wiring into the chunked video read path).
  - Related filings in this folder: DD-198 (attachment upload lifecycle), DD-199 (chunked reads and the download path — the read path this wrapper attaches to), DD-201 (model-boundary image handling), DD-202 (attachment kind classification).
- Build:
  - Absence scan: all 72 `.ts` files under `C:\Users\TZhen\Desktop\dsh-bot\src\` and `C:\Users\TZhen\Desktop\dsh-bot\client\` matched zero occurrences of either media tool's name, or of transcode / codec / rendition / temp-rendition vocabulary.
  - `C:\Users\TZhen\Desktop\dsh-bot\src\core\tools.ts` lines 567–590 (deliver tool's `attachment_paths` forwarded as path strings; comment at 571 that they are never auto-attached).
  - `C:\Users\TZhen\Desktop\dsh-bot\src\adapter\content-blocks.ts` lines 7–18 (text block only; other kinds opaque) and 31–41 (text-only concatenation).
  - `C:\Users\TZhen\Desktop\dsh-bot\src\client\context.ts` lines 323–331 (command transaction carries attachments as opaque unknowns).
  - Ruling cited for the display part: `C:\Users\TZhen\Desktop\dsh-bot\docs\adr\0018-imitate-reference-in-entirety-exception-list.md` line 35 (exception U-B, "rich attachment viewers"); copy policy at line 27 (B9).
