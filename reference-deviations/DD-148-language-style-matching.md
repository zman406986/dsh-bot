# DD-148 — Ghostwriting voice-matching & language rules vs none
- **Area:** system prompts / persona (A17)
- **Type:** missing-feature (partly out of scope)
- **Date:** 2026-09-23

## What the reference does
The reference prompt has a dedicated voice-matching rule for ghostwriting: the first time the assistant drafts or sends anything on the user's behalf on a messaging surface, it should offer to read recent messages from that exact channel, DM, or thread first, so the draft sounds like the user rather than a generic bot. The rationale given is that the user's voice is context-dependent — more polished with external contacts, looser with coworkers, different from one channel or person to the next — so the assistant should sample the specific context it is about to write in and match that register instead of applying one global style.

Notably, the reference base prompt carries no explicit respond-in-the-user's-language rule; its only guidance about language is this rule about matching the audience's register (confirmed by the search done for this review).

## What the current build does
The build has no language rule and no style-matching rule anywhere in its prompt text. The only nod to localization is architectural: all dispatcher prompt text is centralized in `src/core/policy/prompts.ts`, whose header comment states the intent that Chinese copy can land later without code churn (lines 1-5). This matches PRD §10, which requires prompt text to be authored as new copy and reviewed as bilingual if the product requires ZH. There is no runtime language handling on either side of the comparison, and the build additionally has no ghostwriting voice-matching behavior at all — it has no messaging surfaces to ghostwrite on.

## The deviation
The reference ties voice to audience and channel and instructs context sampling before writing for the user; the build drops this entirely, and neither side tells the model to respond in the user's language. The deviation therefore splits in two: (a) a ghostwriting voice-matching behavior that is meaningless in the build's current scope, and (b) the absence of a cheap, generally useful language-matching instruction that would also serve the PRD's requirement for bilingual prompt text.

## Verdict: ADAPT
Ghostwriting voice-matching is out of scope here: the build has no messaging integrations, and both ADR-0004 (reference is a feature inventory, not a build list) and the PRD non-goals (peer messaging hub is optional Phase 2) keep that surface out of scope, so copying that rule would add prompt text for behavior nothing can trigger. The distinct, still-live gap is a respond-in-the-user's-language rule: it is cheap prompt copy, directly supports PRD §10's bilingual requirement, and needs no new runtime machinery. Incorporate the language rule as new adapted copy; leave voice-matching behind, recorded here so the drop is deliberate rather than accidental.

## Incorporation notes
- **Where it would live:** a short new section in the centralized prompt text in `src/core/policy/prompts.ts` (dispatcher and/or worker copy), following the file's convention of stable headings that tests check; no code changes beyond the prose constant.
- **Constraints:** new or adapted copy only per PRD §10 — never textually identical to reference strings; section headings must stay stable because tests check their presence and order; the rule should be phrased as guidance for the model (mirror the language the human writes in) rather than implying runtime language detection, which does not exist; keep it short since there are no ghostwriting surfaces.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying of reference prompt text under any circumstances.
- **Effort/risk:** S — one prose section plus a test marker update; risk is minimal, mainly wording it so it cannot be read as permission to switch languages mid-task.
- **Key reference anchors:** the reference tree's `source/host/runner/system-prompt.ts`, its audience-register/ghostwriting section (~line 207) — the voice-matching rule (out of scope); its absence of any respond-in-user's-language rule (the gap to fill).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/runner/system-prompt.ts` (lines 207-208, voice-matching section; grep confirms no language rule elsewhere in the base prompt)
- Build: `src/core/policy/prompts.ts` (lines 1-5, ZH-later centralization comment; no language or style-matching rule present); `PRD-dsh-multitask-dispatcher.md` §10 "Prompt assets" (line 347, bilingual if product requires ZH); `docs/adr/README.md` ADR-0004 (feature inventory, not build list)
