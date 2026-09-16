# Design 12 — Feature flag + profile split

**Ticket:** `.scratch/multitask-dispatcher/issues/12-feature-flag-and-profile-split.md`
**Status:** design-draft (not implemented)
**Blocked by / inputs:** ADR-0005, PRD §6.1 / §11.5 / §15.6, `src/plugin.ts` (partial), `docs/research/dsh-local-install.md`, `docs/research/plugin-install-workflow.md`, design-11 §5.3

This package is what an implementer follows. It does **not** touch `src/`.

---

## 1. Scope of this ticket

| In | Out |
|---|---|
| Config schema for `enabled` | Multitask core internals (already exist) |
| Where the flag is read and frozen | Policy prompt content (ticket 11) |
| Profile files: multitask ON / stock OFF | dsh adapter live wiring (ticket 09) |
| Plugin `apply` behavior when disabled | Worker tool barrier (ticket 10) |
| Settings/UI control for future sessions | Clean-room audit (ticket 15) |
| Stock-profile isolation guarantees | |

---

## 2. Flag semantics (ADR-0005)

The flag is named **`enabled`** in the plugin config (schemastery key). The product name `multitask_dispatcher` from the PRD is the conceptual feature name; the on-disk / in-UI key is `enabled` because it lives inside the `multitask-dispatcher` plugin's own config namespace — the full dotted path is effectively `multitask-dispatcher.enabled`.

Three rules, non-negotiable:

1. **Read once at dispatcher-session start.** Captured at the top of `apply(ctx, config)`. Never re-read from `config` after that point.
2. **Frozen for the session's lifetime.** The running dispatcher never observes a mid-session change. No code path re-queries `config.enabled`.
3. **Changes apply to the next session only.** A settings/UI write persists the value; the next `apply` picks it up. There is no off-while-running state and no held-result behavior.

---

## 3. Config schema

### 3.1 Schemastery schema (shipped in `src/plugin.ts`)

```ts
import z from "@deepseek-ai/schemastery";

export const Config = z.object({
  /**
   * Feature flag `multitask_dispatcher` (ADR-0005).
   * Read once at dispatcher-session start and fixed for that session's lifetime.
   * A settings change persists for the *next* session; it is not live-applied.
   */
  enabled: z.boolean().default(true),
});

export interface PluginConfig {
  enabled: boolean;
}
```

**Why default `true`:** The plugin is only installed in the multitask profile (§6). Stock profiles never load it, so the default never fires there. Default `true` matches ADR-0005's "ON by default in the dedicated multitask profile." The multitask profile's `cordis.patch.yml` insert row sets `enabled: true` explicitly anyway (belt and suspenders).

**Why not default `false`:** Defense-in-depth argument (if someone installs the plugin in a stock profile without config, default false keeps stock stock). Rejected because stock isolation is the *installation gate* (§6), not the flag default, and default false would make the plugin silently inert for any new profile that forgets the config key. The install row always sets it explicitly.

### 3.2 No other keys

A single boolean suffices (ADR-0005: "A single flag suffices; no experiments/feature-flag framework is in scope"). Do not add kill-switch aliases, percentage rollouts, or environment-variable overrides.

---

## 4. Where the flag is read and frozen

### 4.1 The freeze point: `apply()` entry

```ts
export function apply(ctx: CordisContext, config: PluginConfig): void {
  // ADR-0005: read once at session start; freeze for this session's lifetime.
  // Copy the primitive — do not hold a live reference into `config`.
  const enabled: boolean = Boolean(config.enabled);

  if (!enabled) {
    // Stock dsh behavior: no dispatcher policy, no dispatcher tools,
    // no wake handling, no settings section side effects that alter runtime.
    return;
  }

  // Everything below runs only when the flag is ON.
  // ...
}
```

Key points for the implementer:

- **`Boolean(config.enabled)`** — copy the value. Do not do `const enabled = config.enabled` and then later read `config.enabled` again. Do not use the web-search-exa `current()` lazy-read pattern for this field (that pattern exists so settings changes are picked up live; ADR-0005 forbids that for the flag).
- **Early return** — when disabled, `apply` returns immediately. No `ctx.effect`, no service registration, no tool registration, no prompt injection, no wake subscription. The plugin is a no-op.
- **HMR note** — Cordis may re-call `apply` on hot reload. That is a *new session start*, which ADR-0005 permits ("a change takes effect at the start of the next session"). In production the plugin does not hot-reload; in dev, a HMR reload re-reading the flag is correct behavior, not a bug.

### 4.2 Downstream consumers of the frozen value

Once frozen, the boolean is passed *by value* into the subsystems that need it. None of them re-read config:

| Consumer | Contract (from design-11 §5.3) |
|---|---|
| Policy assembler | `assembleSessionPolicy(enabled: boolean)` — when `false`, returns empty string / no sections. When `true`, returns the dispatcher policy section. Pure function; no config access. |
| Tool registration | Adapter registers the five dispatcher tools only when `enabled === true`. When false, the tool list is untouched (stock dsh tools only). |
| Wake handling | Wake bus / completion-delivery subscription is installed only when `enabled === true`. When false, no wake handler is wired. |
| Reminder middleware | Per-turn reminder is installed only when `enabled === true`. |
| Settings section | Installed regardless of flag value (so the user can turn it back on from the UI), but `onChange` does **not** reconfigure the running session (§5). |

### 4.3 What "read once" means in Cordis terms

Cordis calls `apply(ctx, config)` once per plugin load. The `config` object is the resolved schemastery output for that load. Cordis does **not** re-call `apply` when a settings field changes — plugins that want live config use a `current()` indirection (web-search-exa pattern). We deliberately do not. Therefore:

- The value captured at `apply` entry is authoritative for the entire plugin instance lifetime.
- A settings write updates the persisted config store; it does not mutate the `config` object that `apply` already captured (and even if it did, we copied the boolean).
- The only way to get a new flag value into a running process is a plugin reload (HMR or process restart), which is a new session start.

---

## 5. Settings / UI control (for future sessions)

### 5.1 Mechanism

Follow the `dsh-web-search-exa` template (`docs/research/dsh-local-install.md` Finding 4):

```ts
import { installSettingsSection, settingsNamespace } from "/* dsh-settings */";

// Inside apply(), after the enabled check — or before it, so the control
// is available even when the dispatcher is currently OFF:
installSettingsSection(
  ctx,
  settingsNamespace("multitask-dispatcher"),
  Config,
  config,
  {
    setSource: (next) => {
      // Persist the new config value to the profile's config store.
      // This is what makes the change survive to the next session.
    },
    onChange: (next) => {
      // ADR-0005: deliberately a no-op for runtime behavior.
      // The value is persisted by setSource; the running session
      // does NOT re-read it. Next apply() will pick it up.
      //
      // Optional UX polish (not required for AC): surface a one-line
      // note in the settings UI: "Takes effect at the start of the
      // next dispatcher session."
    },
  }
);
```

### 5.2 When to install the settings section

Two options:

| Option | Behavior | Trade-off |
|---|---|---|
| **A. Always install** (recommended) | Settings section is present whether `enabled` is true or false. User can flip the switch from OFF to ON without editing files. | Slightly more code in the disabled path; but the disabled path is just "install settings, return." |
| B. Install only when enabled | Settings section disappears when the flag is OFF. User must edit `cordis.patch.yml` by hand to turn it back on. | Violates AC ("no file hand-editing"). Reject. |

**Choose A.** The disabled path becomes:

```ts
if (!enabled) {
  installSettingsSection(ctx, settingsNamespace("multitask-dispatcher"), Config, config, {
    setSource: persistConfig,
    onChange: noopRuntime, // ADR-0005
  });
  return;
}
```

### 5.3 What the control writes

The settings section writes to the profile-level config store (the same layer that `cordis.patch.yml`'s `config:` block overrides). Concretely, toggling `enabled` in the UI updates the value that the next `dsh --profile multitask` boot resolves for the `multitask-dispatcher` plugin row. No rebuild, no file hand-editing, no process restart required for the *value to be persisted* — but the running session keeps its frozen flag.

---

## 6. Profile files

### 6.1 Multitask profile (`~/.dsh/profiles/multitask/`)

Created by ticket 01 (`dsh --profile multitask --from-default-profile web --dump-config`). This ticket owns the flag semantics in its config layer.

**`cordis.patch.yml`** — the insert row (already documented in `plugin-install-workflow.md` Finding 2):

```yaml
- insert:
    - id: multitask-dispatcher
      name: dsh-multitask-dispatcher
      config:
        enabled: true
```

- `enabled: true` is explicit, not relying on the schema default. This is the ON half of the split.
- The plugin package is installed via `dsh plugin --profile multitask add file:C:\Users\TZ\Desktop\dsh-bot` (persistent route).

**No other profile files change.** `cordis.yml` stays `[]` (never edit). `package.json` bundles stay `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` (plus the plugin dependency added by `dsh plugin add`).

### 6.2 Stock profile (`~/.dsh/profiles/web/`)

**Zero changes.** Specifically:

- `cordis.patch.yml` keeps its existing Exa search insert and nothing else. No `multitask-dispatcher` row.
- `package.json` has no dependency on `dsh-multitask-dispatcher`.
- The plugin is not in the web profile's dependency tree at all.

### 6.3 Other stock/default profiles

Any profile that is not `multitask` follows the same rule: the plugin is not installed, so the flag is irrelevant. If a user creates a new profile from the `web` template, it starts stock.

---

## 7. How stock profile stays stock (two independent gates)

| Gate | Mechanism | Failure mode if breached |
|---|---|---|
| **1. Installation gate** | Plugin is only `dsh plugin add`-ed into the `multitask` profile. Stock profiles have no package dependency and no `cordis.patch.yml` insert row. | If someone manually adds the plugin to a stock profile, gate 2 catches it only if they set `enabled: false`. |
| **2. Config flag** | `enabled: false` short-circuits `apply` — no tools, no policy, no wake. | If gate 1 is breached and config is absent, schema default `true` would enable the dispatcher. This is why the install workflow always sets `enabled` explicitly and why installing the plugin outside the multitask profile is unsupported. |

**Verification (stock isolation):** dump the stock profile's resolved config and assert there is no `multitask-dispatcher` row:

```powershell
dsh --profile web --dump-config
# Expect: no entry for id "multitask-dispatcher"
```

**Verification (multitask ON):**

```powershell
dsh --profile multitask --dump-config
# Expect: multitask-dispatcher row with config.enabled = true
```

---

## 8. Plugin `apply` behavior when disabled — full picture

```
apply(ctx, config)
  │
  ├─ enabled = Boolean(config.enabled)          // freeze (copy, not reference)
  │
  ├─ installSettingsSection(...)                 // always — user can flip for next session
  │
  ├─ if (!enabled) return                        // ← stock dsh from here down
  │     // No: Multitask instance
  │     // No: dispatcher tools (spawn/check/steer/stop/deliver)
  │     // No: policy assembler invocation
  │     // No: per-turn reminder middleware
  │     // No: wake-bus subscription / completion-delivery handler
  │     // No: worker agent type registration
  │     // No: peer inbox
  │
  └─ // enabled path
        create Multitask core
        create DshHost adapter
        register dispatcher tools
        assemble + inject session policy
        install reminder middleware
        subscribe wake bus
        register worker agent type (with tool barrier)
        ctx.effect(() => { /* disposers */ })
```

When disabled, a session behaves **exactly like stock dsh**: the user gets the normal dsh agent with normal dsh tools, no dispatcher policy in context, no dispatcher tools in the tool list, no background wake handling. The only trace of the plugin is the settings section in the UI.

---

## 9. Interaction with design-11 (policy assembler)

Design-11 §5.3 states: "Policy assembler takes `enabled: boolean` read once at dispatcher-session start. Flag OFF → assembler returns empty / tools not registered. No mid-session re-read."

This design is consistent with that. The assembler signature:

```ts
// src/core/policy/assembler.ts (ticket 11)
function assembleSessionPolicy(enabled: boolean): string {
  if (!enabled) return "";
  return dispatcherPolicyMarkdown; // from prompts/
}
```

In practice, the adapter never calls the assembler when `enabled === false` (it returns early in `apply`). The assembler still accepts the boolean for unit-testability and as a defense-in-depth check. The assembler is pure; it has no config access.

---

## 10. Test plan

### 10.1 Unit tests (no network, no LLM, no dsh host)

| Test | Asserts |
|---|---|
| `apply` with `enabled: false` | Returns early. No `ctx.effect` call. No tool registration. No policy string produced. |
| `apply` with `enabled: true` | Registers tools, calls assembler, installs wake subscription. `ctx.effect` called with disposers. |
| Freeze semantics | Start with `enabled: true`. Mutate the `config` object's `enabled` to `false`. Assert subsequent behavior is unchanged (tools still registered, policy still assembled). Proves no re-read. |
| Settings section always installed | Both `enabled: true` and `enabled: false` paths install the settings section. |
| `onChange` is runtime no-op | Call the `onChange` callback with `enabled: false` after a true-start. Assert no teardown, no tool removal, no policy removal. |
| Policy assembler flag gate | `assembleSessionPolicy(false)` returns `""`. `assembleSessionPolicy(true)` returns non-empty containing expected section headers. |
| Schema default | `Config.parse({})` yields `enabled: true`. `Config.parse({ enabled: false })` yields `enabled: false`. |

### 10.2 Integration tests (local dsh, no network)

| Test | Asserts |
|---|---|
| Stock profile isolation | `dsh --profile web --dump-config` output contains no `multitask-dispatcher` row. |
| Multitask profile ON | `dsh --profile multitask --dump-config` output contains `multitask-dispatcher` with `enabled: true`. |
| Flag-off session = stock | Boot `dsh --profile multitask` with `enabled: false` (via settings or patch overlay). Assert: no dispatcher tools in the tool list, no dispatcher policy in the system prompt, normal dsh behavior. |
| Settings write persists | Toggle `enabled` in the settings UI. Assert the value is written to the profile config store. Assert the running session is unaffected. Boot a new session; assert the new value is in effect. |

### 10.3 Manual demo

1. Boot multitask profile with `enabled: true`. Confirm dispatcher tools present, policy injected.
2. Open settings UI. Toggle `enabled` to `false`. Confirm a note (or lack of runtime change) indicating it applies next session.
3. In the *same* running session, confirm dispatcher still works (tools present, policy active).
4. End session. Boot a new session. Confirm: no dispatcher tools, no policy — stock dsh behavior.
5. Toggle `enabled` back to `true` in settings. Boot again. Confirm dispatcher is back.

---

## 11. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **HMR reload mid-session with workers in flight** | Dev-only | Medium — plugin re-`apply`s, potentially with `enabled: false`, orphaning in-flight workers | Document: HMR is a dev-time concern. In dev, do not toggle the flag while workers run. Production does not hot-reload. ADR-0005 does not define off-while-running; we do not invent it. |
| **User expects settings toggle to take effect immediately** | Medium | Low — confusion, not data loss | Settings UI should show "Takes effect at the start of the next dispatcher session" (UX polish, not AC-blocking). |
| **Cordis passes a live mutable `config` object** | Low | Medium — freeze could be violated if we held a reference | Always copy the boolean (`Boolean(config.enabled)`). Never re-read `config.enabled`. Unit test proves freeze. |
| **Someone installs the plugin in a stock profile** | Low | Medium — stock profile gets a dispatcher | Unsupported. Documented in §7. The install workflow only targets the multitask profile. If it happens, the user must set `enabled: false` manually. |
| **Settings section `setSource` API shape differs from web-search-exa** | Low | Low — settings section may not persist correctly | Verify against the installed `dsh-web-search-exa` source during implementation. Fall back to documenting a `cordis.patch.yml` edit as the non-UI path. |
| **`settingsNamespace` / `installSettingsSection` import path changes across dsh versions** | Low | Low | Pin the import to the dsh version in `peerDependencies`. The API is observed in the installed 0.1.5-rc.1 tree. |

---

## 12. AC checklist (ticket 12)

| AC | Where |
|---|---|
| `multitask_dispatcher` ON in multitask profile, OFF in stock | §6.1 (insert row `enabled: true`), §6.2 (stock has no row), §7 (two gates) |
| Flag read once at session start, fixed for lifetime | §4.1 (freeze at `apply` entry, copy primitive), §4.3 (Cordis semantics) |
| UI/profile control for future sessions, no file hand-editing, no rebuild | §5 (settings section via `installSettingsSection`), §6.1 (insert row is the non-UI fallback) |
| Flag-off = stock dsh (no policy, no tools, no wake) | §8 (apply flowchart), §10.1 (unit test) |
| No off-while-running, no held-result behavior | §2 (three rules), §11 (HMR risk documented, not implemented) |
| Flag-on session never mentions the flag in user-visible output | Inherited from design-11 policy copy ("The user never hears the machinery") — flag is not a user-facing concept in conversation |

---

## 13. Proposed files (implementation, later)

| File | Change |
|---|---|
| `src/plugin.ts` | Finalize `Config` schema (already partial). Add freeze logic, always-install settings section, early-return disabled path. |
| `src/index.ts` | No change needed (already exports `Config`, `apply`, `PluginConfig`). |
| `~/.dsh/profiles/multitask/cordis.patch.yml` | Ensure insert row has `enabled: true`. (Created/maintained outside the repo.) |
| `src/core/policy/assembler.ts` | (Ticket 11) Accepts `enabled: boolean`; returns empty when false. No change from design-11. |

No new core modules. No changes to `DshHost`, `FakeDshHost`, `worker-fsm`, `steer-queue`, `wake-bus`, or `types.ts`.

---

## 14. Open points for the implementer (not blockers)

1. **`setSource` exact signature** — read the installed `dsh-web-search-exa` `lib/index.js` to confirm the callback shape before wiring. The pattern is clear; the exact types may need a local interface.
2. **Settings UI "next session" hint** — if dsh's `installSettingsSection` supports a description or help text on fields, add "Applies at the start of the next dispatcher session" to the `enabled` field. If not, skip; the behavior is correct without it.
3. **Whether `installSettingsSection` is safe to call before the `enabled` check** — it should be (it only registers a UI section, not runtime behavior), but verify no side effects in the dsh settings service that assume the plugin is fully active.
