# 12 鈥?Feature flag + profile split

**What to build:** The switch that decides whether a dsh installation has a dispatcher at all. It is on in the dedicated multitask profile, off everywhere else, and it is decided at the start of a session so it can never be half-applied.

**Blocked by:** 11 鈥?Dispatcher tools + policy prompts.

**Status:** open

Note: the multitask profile must be created 鈥?only `web` exists on this machine (`docs/research/dsh-local-install.md`). Ticket 01 establishes it; this ticket owns the flag semantics.

- [x] The `multitask_dispatcher` flag is ON in the dedicated multitask profile and OFF in stock/default profiles.
      Multitask `cordis.patch.yml` insert row sets `enabled: true`. Stock `web` profile has no `multitask-dispatcher` row (installation gate).
- [x] The flag is read once at dispatcher-session start and fixed for that session's lifetime; the core never observes a mid-session change.
      Frozen at `apply()` entry via `const enabled = Boolean(config.enabled)` (copy primitive, not live reference). Unit tests prove mutating `config.enabled` after apply does not change the running session.
- [x] The setting is exposed as a profile/UI control that writes the value for future sessions 鈥?no file hand-editing and no rebuild required to change it.
      `installMultitaskSettingsSection` always installs the settings section (both flag paths). `onChange` is a runtime no-op; the settings provider persists for the next `apply()`.
- [x] With the flag off, a session behaves exactly like stock dsh: no dispatcher policy, no dispatcher tools, no wake handling.
      Disabled path returns early after installing only the settings section 鈥?no Multitask core, no tools, no policy, no wake subscription.
- [x] No off-while-running state exists and no held-result behavior is implemented.
      ADR-0005 three rules; tests assert onChange/setSource storms leave the session intact.
- [x] A session started with the flag on runs normally with no reference to the flag in any user-visible output.
      Policy copy (T11) never mentions the flag; flag is not a user-facing conversation concept.

## Implementation notes

- Config key stays `enabled` (schemastery boolean, default true). Conceptual name `multitask_dispatcher`; on-disk key `enabled` in the `multitask-dispatcher` plugin namespace.
- Default `true` because stock isolation is the installation gate (搂7 two gates), not the flag default. The multitask profile's insert row sets `enabled: true` explicitly.
- Settings API: structural `ctx.settings.installSection` (current dsh 0.1.5-rc.x surface). No hard dependency on `@deepseek-ai/dsh-settings`.
- Policy assembler already accepts `enabled: boolean` and returns `""` when false (design-11 / T11).
- Profile verification: `dsh --profile web --dump-config` 鈫?no multitask-dispatcher row; `dsh --profile multitask --dump-config` 鈫?`enabled: true`.
