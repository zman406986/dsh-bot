# DD-198 — Attachment staging and upload lifecycle vs path-string forwarding
- **Area:** A25 attachments & media
- **Type:** behavior-delta
- **Date:** 2026-09-23

## What the reference does
The reference treats an attachment as **bytes in transit**, not as a filesystem reference, and it manages those bytes through an explicit three-phase staging lifecycle.

- A desktop attachment manager owns a dedicated staging directory under the product's data root, plus a containment predicate that decides whether a given path lies inside that staging area (used as the trust boundary before staged bytes are re-read).
- A staging service on the host side moves host-visible paths into a staging area scoped to that machine, returning a mapping from source path to staged path.
- A commit routine consumes a list of staged paths paired with display filenames, validates each pair (non-empty string path, safe filename shape, path still inside the staging directory), reads the bytes back off disk, rejects empty payloads, and then pushes them across the boundary. The upload step is what returns the durable reference the rest of the system keeps; on any per-item failure the commit aborts and reports through a commit-labelled error channel. A companion discard operation releases a staged path that was never committed.
- A single wiring site in the main edge binds the whole family onto the RPC interface in one line: resolve media, read text, read bytes with a caller-supplied ceiling, stage bytes, download, commit staged, discard staged, and fetch link metadata (`reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/electron-main/main-edge.ts:141`). The protocol dispatcher carries the corresponding methods, including the upload step at `.../source/host/gateway-protocol.ts:113`, alongside separate read operations for image bytes, text, and byte chunks.
- The upload step is base64 over the protocol and resolves to a path (`.../source/electron-main/attachments/attachments.ts:15`), so the reference's own answer to "where do the bytes live after upload" is still a path — but a path that the host process created, in a directory the host owns, reached only after the bytes were validated and copied.
- Size ceilings are declared centrally and are type-sensitive: a general attachment ceiling and a larger video ceiling, with a notice formatter that picks the applicable ceiling from the filename's apparent kind (`.../source/shared/media/attachment-limits.ts:2`). A desktop preview path independently caps preview bytes at the general ceiling.
- An attachments service hashes byte payloads with sha256 and derives the on-disk name from the digest, giving content-addressed storage with a short extension hint preserved (`.../source/host/extensions/attachments/attachments-service.ts:47`, `:200`, `:223`).

Read together: the reference's lifecycle exists because bytes must cross a process boundary (desktop renderer/preload side into the host process), and the staging directory is what makes that crossing auditable — the containment check is what allows the commit step to trust a path handed to it.

## What the current build does
The build forwards **path strings** and never carries bytes across any process boundary:

- The client's command-execution path passes an empty attachments array — the composer's command transaction is invoked with no attachment payload at all (`src/client/actions.ts:253`). The typed face it calls does accept an attachments list (`src/client/context.ts:321-334`), so the parameter is modelled but unused at this call site.
- The deliver tool exposes an optional array of local path strings in its input schema and hands them straight through to the delivery dependency (`src/core/tools.ts:567-587`). The schema description states the dispatcher chooses these paths and that they are never auto-attached from a worker report.
- The build's command-definition type in the host adapter advertises an optional input hint carrying a boolean attachments flag (`src/adapter/cordis-dsh-host.ts:135-141`), with the comment noting the hint is menu-visible and never host-enforced. This is an advertisement, not a transport.
- No staging directory, no commit/discard pairing, no byte ceiling, and no digesting of attachment payloads appear anywhere under `src/`. Grep-level absence, not an exhaustive audit.

So a worker that needs an attachment is handed a path and opens the file itself. Nothing is copied, validated, or ceilinged on the way, because nothing is transported.

## The deviation
The reference invests in a byte-transport lifecycle — staging directory, containment check, commit/discard pairing, central type-sensitive ceilings, content-addressed naming — because its attachment bytes must cross from one process into another and the receiving side must be able to trust what it is handed. The build invests in none of this because it has no such crossing: every actor shares one filesystem and one machine, so a path is already a complete and unambiguous reference to the file.

The consequence is a different set of failure modes rather than a missing feature. In the reference, a path is only trusted after it has passed containment; in the build, a path handed to a worker is trusted as given, and the worker's read is the first and only validation — subject to whatever the worker's own tooling enforces, and to no size ceiling that the dispatcher imposes. Nothing in the build bounds the size of a file that a path can point at. Conversely, the build has no staging lifetime to manage and no orphaned staged bytes to reap, which is a real operational cost the reference pays and the build avoids entirely.

The deviation is therefore architectural, not an oversight: the build's path-string forwarding is the correct shape for a local single-machine plugin, and the reference's lifecycle is the correct shape for one whose attachment bytes must traverse a protocol boundary. Byte transfer starts to matter at the moment a worker stops sharing the dispatcher's filesystem.

## Verdict: DO-NOT-INCORPORATE
No recorded ruling in the authority stack names attachment transport. ADR-0018 exception U-B excludes rich chat ergonomics — viewers, cards — but that exception governs display, not transport, so it does not decide this and should not be stretched to cover it. The PRD's non-goals put remote sandbox out of scope, which is precisely the architecture that would give the staging lifecycle a consumer. Absent a remote worker, the staging machinery would exist with nothing to transport, and adding it would buy the build an obligation (staged-file lifetime, reaping, enforcing containment) in exchange for a guarantee it already gets from sharing a filesystem. The one genuinely transferable idea is a size ceiling on what a forwarded path may point at, and that is a small independent hardening rather than a reason to adopt the lifecycle.

## Incorporation notes
- **Where it would live:** Nothing is proposed for incorporation. If a size ceiling on forwarded paths were ever wanted, it would attach at the deliver tool's input handling (`src/core/tools.ts`) and at the client command path (`src/client/actions.ts`). A byte transport, if ever needed, would have to be a new mechanism rather than an extension of the existing adapter type at `src/adapter/cordis-dsh-host.ts`.
- **Constraints:** Any future remote-worker work re-opens this decision outright and should re-derive it then, not inherit it now. The build currently has no protocol path capable of carrying bytes; the reference's equivalent path sits in a protocol dispatcher that the build has no analogue of. Do not adopt the staging lifecycle without also adopting the containment check that justifies trusting a staged path — the two are one mechanism.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — adopting the lifecycle would require a new byte-transport mechanism, a staging directory with a lifetime and reaping story, and central ceilings; the risk is building transport scaffolding ahead of the remote-worker need that would justify it.
- **Key reference anchors:** `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/electron-main/main-edge.ts:141` (single wiring site for the whole attachment family); `.../source/electron-main/attachments/attachments.ts:15` and `:95` (upload step shape and the commit routine's validation-then-transfer order); `.../source/electron-main/attachments/attachment-manager.ts:7` (staging directory and containment predicate); `.../source/host/extensions/attachments/box-staging.ts:14` (host-side staging); `.../source/host/extensions/attachments/attachments-service.ts:47`, `:200`, `:223` (sha256 content addressing); `.../source/shared/media/attachment-limits.ts:2` (type-sensitive ceilings); `.../source/host/gateway-protocol.ts:113` (upload protocol step, with sibling read steps following).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/electron-main/attachments/attachment-manager.ts`, `.../source/electron-main/attachments/attachments.ts`, `.../source/electron-main/main-edge.ts`, `.../source/host/extensions/attachments/box-staging.ts`, `.../source/host/extensions/attachments/attachments-service.ts`, `.../source/shared/media/attachment-limits.ts`, `.../source/host/gateway-protocol.ts`
- Build: `src/client/actions.ts:253`, `src/core/tools.ts:567-587`, `src/client/context.ts:321-334`, `src/adapter/cordis-dsh-host.ts:135-141`
