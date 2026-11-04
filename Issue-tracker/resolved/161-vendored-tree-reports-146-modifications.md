# 161 — The vendored racoons tree reports 146 modified files when only 31 carry real changes

**Status:** resolved
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

## Comments

### Resolution (2026-11-04)

**Cause confirmed, and it is the one the ticket guessed, but the mechanism has a second half the ticket did not name.**

The vendored sources are LF (upstream blobs, copied with `-c core.autocrlf=false`). This repo runs `core.autocrlf=true` and nothing pinned the vendored paths. So the index holds LF while the checkout writes CRLF. A re-sync honestly writes the LF bytes; git then compares a size-mismatched stat against the index and marks every such file stat-dirty **without** a content change. That split is the signature:

| Check | Result |
|---|---|
| `git status --porcelain -- vendor` | 143 entries (ticket measured 146 on its tree) |
| `git diff --name-only -- vendor` | 0 |
| `git diff --numstat -- vendor` | 0 |
| `git hash-object --path=<f> -- <f>` vs `git rev-parse :<f>` | identical for all 149 files |

An entry that `status` reports and `diff` does not is a stat-dirty index entry, not a modification. Reproduced in a throwaway clone by writing the tarball's LF bytes over the tree:

```
STEP2_eol=      6 w/crlf     143 w/lf
STEP2_git_status_count=143
STEP2_git_diff_count=0
STEP2_git_diff_numstat=0
  vendor/racoons/core/index.ts  worktree=8d96cbe2cb601034195707fd484f31280fb7ac6d  index=8d96cbe2cb601034195707fd484f31280fb7ac6d
```

**The second half: the attribute is not the whole fix.** Measured — `.gitattributes` plus `git update-index --refresh` leaves all 143 entries, and refresh exits 1 with `vendor/...: needs update`. Git does not re-evaluate already-dirty stat data from a new attribute. The clearing step is a one-time `git add --renormalize`, which is what the ticket anticipated in its fourth acceptance item.

**What was changed.** `.gitattributes` at the repo root:

```
vendor/racoons/** text eol=lf
```

`text eol=lf` (not `-text`): `-text` cleared 143 but left 6 genuinely-CRLF paths still dirty, because it stops git caring about endings instead of pinning them. `text eol=lf` pins checkout and re-sync to the blobs and leaves 0.

**Acceptance, item by item.**

- *Fresh `git status` clean, clean clone shows no phantom modifications* — met. Fresh clone of the fixed tree checks out `149 w/lf`, `git status --porcelain -- vendor` = 0. A simulated re-sync writing LF bytes over the whole tree leaves `status_after_resync = 0`.
- *Byte-exactness survives* — met. `checked=149 mismatches=0` comparing `git hash-object --path` against `HEAD:<path>` for every vendored file; a raw byte read of a sample file shows `CRLF 0, LF 197`. No file gained CRLF.
- *Mechanism recorded next to the `autocrlf` paragraph in PROVENANCE* — **not done.** `vendor/racoons/` was read-only for this lane and the fix did not genuinely require a tracked change there; the operator instruction was to report before editing. The recorded home is therefore the `.gitattributes` comment block, which states the rule and points at PROVENANCE for the byte promise. A follow-up should add one sentence to `PROVENANCE.md`'s `autocrlf` paragraph naming `.gitattributes` as the mechanism; that file is outside this lane's ownership.
- *One-time renormalize stated with expected diff size, not silently changing 115 files* — met, and the expected diff size is **zero**. With `text eol=lf` in place, `git add --renormalize -- vendor` stages nothing, because the index blobs were already LF. The renormalize only refreshes stat data. Recorded here so a future re-sync does not re-derive it.

**Not-a-bug?** No. The measurements stand and the noise is real.

Note for the record: another lane's commit `e99ffa3` swept this `.gitattributes` in along with unrelated work; this lane committed nothing.
