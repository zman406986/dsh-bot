# DD-063 — Clipboard paste with staged upload lifecycle vs none
- **Area:** composer attachments (A7)
- **Type:** missing-feature (subordinate to DD-061)
- **Date:** 2026-09-23

## What the reference does
Pasting files into the prompt editor is a first-class intake path: the composer wires a paste-files handler prop into the editor (`the reference tree's frontend/src/recovered/features/conversation/workspace/composer.tsx:190`), and a helper walks a `DataTransferItemList`, keeping every item whose kind is a file and pulling out a `File` for it (`composer.tsx:49-58`). Staging then goes through the desktop bridge one file at a time — bytes in, either a staged attachment (path, name, size, optional mime type) or a failure tagged as empty, oversized, or a generic staging failure (`workspace/desktop.ts:21,57-75`). Failed stages surface as user-facing notices whose copy encodes the size policy: roughly 25 MB per file generally, 200 MB when the extension is a known video type, plus a distinct empty-file message and a plural form (`desktop.ts:42-55`). On submit the staged paths are exchanged for committed ones via the bridge's commit-staged-attachments call, and the bridge surface also exposes discard and download operations alongside it (`contracts/desktop-bridge.ts:380-386`, commit usage at `desktop.ts:86-97`).

## What the current build does
There is no clipboard file intake and no staging pipeline anywhere under `src/client` or `src/adapter` — a repo-wide search for paste/stage/`DataTransfer` hooks finds only outbound copy-to-clipboard plumbing for peer traffic (`src/client/shell.tsx:267-314,679`), which is a different concern. Attachment awareness exists only on the render side, as honest placeholders: an incoming user turn that carries attachments but no text renders a "(no text content)" placeholder (`src/client/conversation.tsx:357-360`, copy key at `src/client/overlay.ts:266,450`), and a tool view counts `attachment_paths` arguments (`src/client/toolviews.ts:326-330`). The build can display that attachments existed; it cannot create them from a paste.

## The deviation
The reference treats paste as a gated upload lifecycle — collect the files, stage each one through the bridge with typed failures, show size-policy notices, then commit on submit (with discard available) — while the build has none of it: no paste handler, no staging bridge calls, no size limit enforcement or messaging. Any attachment data the build shows arrives from elsewhere and is only read, never authored, from the client.

## Verdict: DO-NOT-INCORPORATE
This depends on DD-061's disposition, which is also DO-NOT-INCORPORATE (ruled by ADR-0018 U-B — the exception for no rich chat ergonomics, which excludes attachments UI): the build deliberately has no composer attachment intake, and a paste path without the attachment feature it feeds has nothing to stage into. If attachment intake is ever built (most plausibly alongside the pending attachments backend — DD number pending, attachments backend), the reference's size policy is a useful anchor to re-derive rather than copy: a general per-file cap around 25 MB with a much larger allowance (~200 MB) for video, surfaced as per-file failure notices with distinct empty/failed reasons and a staged-then-committed handoff at send time.

## Incorporation notes
- **Where it would live:** a paste hook on the composer editor plus a staging module beside the (hypothetical) attachment model in `src/client`; the byte-transfer boundary belongs between the host and the bridge, mirroring how the reference splits editor intake from bridge calls.
- **Constraints:** no staging without a backend that accepts bytes (see DD number pending, attachments backend); size limits and failure taxonomy must be re-derived against the build's own backend limits, not transplanted; any notice copy must come from the build's copy tables (`src/client/overlay.ts`), not the reference's strings.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — a paste handler is small, but the staged/commit lifecycle only earns its keep once an attachments backend exists (DD-061 dependent), so doing it standalone would be dead code with added risk.
- **Key reference anchors:** `the reference tree's frontend/src/recovered/features/conversation/workspace/composer.tsx:49-58,190` (clipboard file collection, handler wiring); `the reference tree's frontend/src/recovered/features/conversation/workspace/desktop.ts:21,42-75,86-97` (failure reasons, size-limit notices, stage/commit calls); `the reference tree's frontend/src/recovered/features/contracts/desktop-bridge.ts:380-386` (commit/discard/download bridge surface).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/composer.tsx` (paths relative to `reference material-NOT LICENSE SAFE DONT COPY-grok bot/`)
- Build: `src/client/conversation.tsx:357-360`, `src/client/overlay.ts:266,450`, `src/client/toolviews.ts:326-330`, `src/client/shell.tsx:267-314,679` (absence verified by search of `src/client` and `src/adapter`)
