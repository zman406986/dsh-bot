# DD-102 — Auto-review rules editor vs boolean/number-only settings card
- **Area:** settings (A12)
- **Type:** missing-feature (no settings control type exists for editing a list)
- **Date:** 2026-09-23

## What the reference does
The reference settings overlay carries an auto-review section with two layers. A master switch turns the feature on; when on, an editable rules table appears in which each row pairs a short natural-language instruction with one of two behaviors — run without asking, or pause and ask first (ask wins on conflict, per the section's own helper text). Rules are entered through a draft text field capped at 1000 characters plus a behavior selector and an add button; existing rows can be edited in place (text and behavior together) or deleted. Each behavior list holds at most 20 instructions (a per-behavior instruction cap of 20), and a save that would duplicate an instruction already present in the same list is rejected outright. The rules are stored in the settings store under a dedicated auto-review-instructions key; the store's setter normalizes the value on write and removes the stored key entirely when the feature is off with both lists empty.

## What the current build does
The web client's settings surface is a card assembled from field specs. The spec's `kind` union admits exactly two controls — `"boolean" | "number"` — each spec carrying only a format/parse pair for the scalar draft text (`src/client/settings-card-store.ts:111-124`). The shipped field list contains exactly two entries mirroring the plugin `Config` (`enabled`, `accessRequestTimeoutMs`), and the pair is checked offline against `Config.dict` so an unmapped field fails the suite rather than silently hiding part of the namespace (`src/client/settings-card-store.ts:193-214`). There is no list or array field kind, no row-level editing control, and no plugin-side place for user-authored rule lists.

## The deviation
The reference's auto-review configuration is a composite feature — durable per-user rule lists plus a list-editing UI — that the build's field-spec system cannot express even partially: adding it is not one more card row but a new field kind (or a separate surface), a normalization layer over list-shaped stored state, and a decision about where the data lives. The persistence half is the hard part: standing allow/ask rules are exactly the kind of durable policy state whose permissibility the build has not ruled on (see Verdict).

## Verdict: ASK-HUMAN
Durable auto-review rules collide with the build's rule that consent is scoped to a session: a stored allow list lets future sessions run actions without asking, and whether any consent or policy may outlive a session is precisely the open question in the A28 policy-persistence filing (DD number pending). No accepted ADR or recorded ruling settles that collision, and the precedence order (ADR-0018; the rule against silently picking on unruled conflicts) sends it to the human. The runtime side of auto-review — the approval card shown when an action needs consent — is already covered by DD-077 (ADAPT); this filing concerns only the rules editor and its durable store, and nothing in it should be built before the A28 ruling lands.

## Incorporation notes
- **Where it would live:** contingent on the A28 policy-persistence ruling. If durable rules are allowed at all: rule storage host/plugin-side behind the existing settings-scope snapshot mechanism (never as ad-hoc client state), with the editor in `src/client` either as a new field-spec kind in `settings-card-store.ts` or as a dedicated card outside the scalar field list.
- **Constraints:** a list-editor kind must pass the offline field check against `Config.dict` (or the check must be consciously extended); the reference's own guardrails — 20 instructions per list, duplicate rejection within a list, 1000-character cap, disabled-and-empty removes the stored key — are behavioral contracts worth re-deriving independently; rules must map onto whatever consent vocabulary A28 settles, not the reference's allow/ask labels verbatim.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — a new field-spec kind plus storage semantics, gated on an unresolved policy question that could void the whole feature.
- **Key reference anchors:** `the reference tree's frontend/src/recovered/features/settings/overlay/auto-review.tsx` (switch, table, inline edit/delete, 1000-char caps); `the reference tree's frontend/src/recovered/features/settings/overlay/model.ts` (cap constant line 14; duplicate-rejecting save lines 40-59); `the reference tree's source/shared/node/settings/sand-settings-store.ts:27,152-153` (stored key, setter that normalizes the value).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/settings/overlay/auto-review.tsx`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/settings/overlay/model.ts`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/shared/node/settings/sand-settings-store.ts`
- Build: `src/client/settings-card-store.ts`

Cross-refs: DD-077 (auto-review approval card, runtime side); DD-098 (settings-surface architecture); A28 policy-persistence filing (DD number pending).
