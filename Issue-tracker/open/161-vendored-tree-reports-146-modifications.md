# 161 — The vendored racoons tree reports 146 modified files when only 31 carry real changes

**Status:** open
**Labels:** needs-triage
**Blocked by:** nothing. Found while preparing the repo for publication (2026-10-29).
**Origin:** measured by the release-prep session, 2026-10-29, after the ticket-148-style re-sync to `b838ae79203767a8c92232b7d04664a1151b015a`.
**Related:** `vendor/racoons/PROVENANCE.md` (the byte-exactness promise and the `core.autocrlf` note), ticket 148 (the previous re-sync, which recorded the same hazard).

## Problem

After the re-sync, `git status` lists **146** entries under `vendor/racoons/` as modified. Only **31** of them carry a content change. The other 115 are byte-identical to their blobs in `HEAD`.

Measured on 2026-10-29:

| Check | Result |
|---|---|
| `git status --porcelain -- vendor` | 146 entries |
| `git diff --name-only -- vendor` | 31 files |
| `git diff --numstat -- vendor` | 31 files, +573 / −429 |
| `git hash-object --path=<f> -- <f>` vs `git rev-parse :<f>` | identical for a sampled phantom |
| A commit simulated in a throwaway `GIT_INDEX_FILE` | 31 files staged, nothing else |
| Working-tree CRLF pairs on a sampled file | 0 |
| `HEAD` blob CRLF pairs on the same file | 0 |
| `core.autocrlf` in this repo | `true` |

So the phantom entries do **not** enter a commit, and `HEAD` integrity is unaffected. The cost is a `git status` that cannot be read, which matters before a repo goes public: a contributor sees a dirty tree on a clean checkout and cannot tell real changes from noise.

## Diagnosis

`core.autocrlf=true` is set in this repo and no `.gitattributes` pins the vendored paths. The vendored sources are deliberately LF so they match the upstream blobs byte for byte (PROVENANCE, "Copy discipline"); git, expecting to write CRLF on checkout, reports each such file as modified. `git update-index --refresh` exits 0 and does not clear them.

Adding `.gitattributes` with `vendor/racoons/** -text` did **not** clear the existing entries — it does not re-evaluate already-indexed stat data without a renormalize pass. That was tested and the test file was removed; nothing was left behind.

## Acceptance

- [ ] A fresh `git status` on the published tree shows the vendor files as clean, and a clean clone on Windows shows no phantom modifications.
- [ ] The byte-exactness promise survives: every vendored file still compares equal to `git cat-file -p <pin>:<path>`, and no file gains CRLF.
- [ ] The chosen mechanism is recorded in `vendor/racoons/PROVENANCE.md` next to the existing `autocrlf` paragraph, so a future re-sync does not reintroduce the noise.
- [ ] If the fix requires a one-time `git add --renormalize`, it is stated as a one-time step with its expected diff size, and it does not silently change 115 files' bytes.

## Constraints

- The vendored sources stay LF. Do not "fix" this by converting the tree to CRLF; upstream blobs are LF and PROVENANCE demands byte equality.
- Do not use upstream's `resync-vendor.mjs`.
- No change to the pinned commit as part of this ticket.