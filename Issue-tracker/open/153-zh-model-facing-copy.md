# 153 — Model-facing copy ships in English only while the client dictionary ships en + zh

**Status:** open
**Labels:** ready-for-agent
**Origin:** PRD gap scan 2026-10-28 — verified against the tree; nothing implemented. This is the recorded M4 remainder (PRD:394).
**Related:** PRD §10 (prompt assets), §13 M4 (exit: adapted-copy review; ZH/EN prompts), ADR-0018 B9 (re-derive independently — ZH is new copy, never a translation of reference text), ticket 154 (the review that must cover the new copy).

## Problem

Every model-facing asset is English-only:

| Asset | Location | ZH today |
|---|---|---|
| Dispatcher policy section, standing rules, wake instructions, access block, peer wake, peer roster heading/intro, all eight tool descriptions | `src/core/policy/prompts.ts:77-141`, `buildDispatcherPolicySection` `:162`, `buildStandingRulesBlock` `:212`, `buildWakeInstructionsBlock` `:225`, `buildAccessPolicyBlock` `:246`, `buildPeerWakeInstructionsBlock` `:266` | none |
| Worker system prompt (contract, report format, no-user-DM, no-todo-list) | `src/worker/prompt.ts:46` | none |
| Wake cues and resume cue | `src/adapter/wake-copy.ts:12-33` | none |
| Access-ask prompt strings and decision labels | `src/adapter/access-prompt.ts:84-100`, `:170-178` | none |

Meanwhile the client face ships a two-language dictionary: `localeDictionary` with `en` (`src/client/overlay.ts:116`) and `zh` (`src/client/overlay.ts:328`), registered through `ctx.locale.register(ns, {zh, en})` (`src/client/context.ts:79-84`; call site `src/client/index.ts:212`).

So a Chinese user reads a fully translated UI while the dispatcher thinks and instructs its workers in English. Verified: no CJK character appears in any of the four files above, and none of them reads a language setting.

## The seam question the implementer must settle first

There is exactly one language switch in the product today, and it is client-side: the host `locale` settings namespace carries a `preference` field (`@deepseek-ai/dsh-client-locale` types: `LOCALE_SETTINGS_NAMESPACE = "locale"`, `LOCALE_PREFERENCE_FIELD = "preference"`, `LOCALE_IDS = ["zh", "en"]`, absence delegates to the browser).

The plugin does **not** read it: `inject` is `subagents, agents, jobs, storageDomain, tools, commands, userQuestions, approval` (`src/plugin.ts:173-182`) — no `settings`, no locale service. Copy is assembled server-side (policy inject via `src/adapter/parent-agent.ts`, worker prompt at composition), so the client `t` seat cannot serve it.

Pick one and record the choice in the ticket comment before writing prose:

1. Inject the host settings service and read `locale.preference` (`undefined` → EN).
2. Add a volatile `Config` field (`language: "en" | "zh" | "auto"`, default `auto`), which also gives the settings card a control and keeps the read inside the plugin's own schema (ADR-0005's volatile-only rule, `src/plugin.ts:71-73`).
3. Ship ZH selectable only through the existing locale preference and treat a missing service as EN.

Whatever is chosen must fail closed to EN when the preference is absent, unreadable, or names a language we do not ship. Do not invent a new language store.

## What to do

- Add a ZH variant for each row of the table above, with meaning parity — same rules, same tool names, same numbered bounds (120 s await, 8 tools, 8,000 chars, the roster cap). Tool names stay literal ASCII identifiers; do not transliterate them.
- Keep ZH and EN in the same module per asset (the `prompts.ts` header already says the prose lives in one place "so ZH can land later without code churn", `src/core/policy/prompts.ts:1-5`).
- Add a selection function per asset and route every call site through it. Section headings become part of the selected variant; the test marker lists (`POLICY_SECTION_HEADINGS`, `REMINDER_SECTION_HEADINGS`, `WAKE_SECTION_HEADINGS`, `ACCESS_SECTION_HEADING`, `PEER_WAKE_SECTION_HEADINGS`, `PEER_ROSTER_SECTION_HEADING`) need ZH counterparts, and the tests that assert heading presence/order must run for both languages.
- Keep the `(empty)` ledger marker handling honest in ZH (it is a marker, not prose — `src/core/policy/prompts.ts:141`, rendered at `src/core/policy/assembler.ts:85-88`).

## Acceptance

- [ ] Every asset in the table has an EN and a ZH variant with meaning parity (same rules, same numbers, same tool names).
- [ ] Selection follows the chosen seam; absent/unknown preference yields EN, never a mixed-language block.
- [ ] Existing EN tests still pass unchanged in meaning; new tests pin heading order for ZH and pin that ZH text contains no forbidden vocabulary either.
- [ ] ZH copy is authored, not machine-translated from the reference; ADR-0018 B9 provenance noted in the ticket comment.
- [ ] The PRD's M4 row (§13) and `docs/surfaces.md` no longer say "EN only".

## Constraints

- Copy only: no behavior change, no new tool, no change to what the dispatcher is told to do.
- Never translate the reference tree's text; re-derive in Chinese from the PRD rules (ADR-0018 B9).
- Read-only against `vendor/racoons/**` and the reference-material folder.
- Offline tests only.

## Comments

2026-10-28: Filed from a read-only gap scan. Verified by grep: zero CJK characters in `prompts.ts`, `worker/prompt.ts`, `wake-copy.ts`, `access-prompt.ts`; the client dictionary has both faces (222 key lines in `overlay.ts`). The "existing language-switch seam" is the client locale preference, and the plugin does not read it today — that wiring is part of this ticket, not assumed as present.

2026-10-28 — **Step 1 of 2 done (policy asset only).** Remaining step 2: worker contract (`src/worker/prompt.ts`) plus the wake/access blocks (`buildWakeInstructionsBlock`, `buildAccessPolicyBlock`, `buildPeerWakeInstructionsBlock`, peer roster heading/intro) and the eight tool descriptions. Status stays open until step 2 lands.

**Seam chosen (option 1, scoped to step 1).** The policy face is keyed by the same two ids the client dictionary uses — `"zh"` / `"en"`, matching the host's `LOCALE_IDS` order — via `PolicyLanguage` and `resolvePolicyLanguage` (`src/core/policy/prompts.ts`). Selection is fail-closed and exact-match only: anything other than the literal `"zh"` (`undefined`, `null`, `"en"`, `"zh-CN"`, `"ja"`, a non-string) composes EN. No prefix matching on purpose — a half-translated policy is worse than an English one. `buildDispatcherPolicySection(origin, generation, language)` and `assembleSessionPolicy(enabled, origin, generation, language)` take it as a trailing argument defaulting to `"en"`, so every existing caller composes byte-identical EN.

Wiring the live preference read (`ctx.settings` / `locale.preference`) into `src/adapter/parent-agent.ts` is **not** in step 1: it is a behaviour change on the activation path, and this step is copy-only per the ticket's Constraints. The seam is a pure function today, ready for that one call site.

**Copy.** ZH block in `prompts.ts` as `buildDispatcherPolicySectionZh`, sibling to the untouched EN face. Re-derived in Chinese from the PRD rules — authored copy, never a translation of the reference tree (ADR-0018 B9). Terminology follows the client dictionary's zh face so model and UI name the same things: 调度器 / 工作者 / 待办 / 纠偏 / 流 / 送达 / 唤醒 / 会话 / 代理. Tool names and status literals stay ASCII (`spawn_worker`, `in_progress`, `completed`, …).

**Tests.** New `dispatcher policy — ZH face (ticket 153)` suite in `test/policy-assembler.test.ts` (13 cases): fail-closed selection, EN byte stability, ZH heading presence/order via `POLICY_SECTION_HEADINGS_ZH`, 25 EN↔ZH directive pairs, literal tool identifiers, the bounded-wait bound, no EN leftovers outside backticks, no forbidden vocabulary, exactly three origin-dependent lines, spawned generation line, EN/ZH line-shape equality, and no CJK in the EN face. The ticket-141 sha256 pin did **not** move — the EN face is byte-identical, which is exactly what that pin proves.

**Still to do (step 2).** The PRD M4 row and `docs/surfaces.md` still say EN only; both move with step 2, when the whole table is covered. The live preference read on the activation path also lands there, once the last asset has a ZH face.
