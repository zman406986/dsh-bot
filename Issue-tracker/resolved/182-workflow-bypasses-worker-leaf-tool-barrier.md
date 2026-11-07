# 182 — Inherited workflow capability bypasses the worker-leaf tool barrier

**Status:** resolved
**Labels:** ready-for-agent
**Severity:** high
**Ship blocker:** yes — on the inspected installed host, a worker inheriting the standard preset retains a usable agent-orchestration capability even when worker composition succeeds.

## Problem and impact

A worker can call the inherited `workflow` tool and use its script-level `agent()` function to start descendant work and obtain its result. The worker barrier denies native spawn verbs and `await_agent`, but omits this alternate orchestration capability. The workflow engine calls the host subagent service directly, bypassing the plugin's tracked worker-spawn path. This violates the worker-leaf and single-dispatcher accountability contract in [CONTEXT.md:15–16](<C:/Users/TZ/Desktop/dsh-bot/CONTEXT.md#L15-L16>) and [ADR-0003:3–5,17–23](<C:/Users/TZ/Desktop/dsh-bot/docs/adr/0003-dispatcher-only-spawning.md#L3-L23>).

The security impact is unauthorized descendant/work orchestration outside the plugin's worker registry, stream-key/todo linkage and settle/wake accounting. Host workflow/subagent records may still exist; “untracked” here means outside this plugin's accountability path. No exceptional composition failure is required. This establishes a worker capability-boundary bypass, not general host compromise or arbitrary messaging to unrelated users.

## Confirmed static evidence

- **Installed version and inherited capability:** [installed dsh/package.json:4](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json#L4>) reports `0.2.2-rc.1`. [standard.patch.yml:106–111](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml#L106-L111>) mounts `workflow-ptc` with `provider: spawn` and `tool-workflow`. [dsh-subagent/lib/index.js:347–354](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js#L347-L354>) selects the parent's composed preset when no child preset is selected; [composition:374–383](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js#L374-L383>) composes from the parent in that case. [dsh-tool-workflow/lib/index.js:60–67](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-workflow/lib/index.js#L60-L67>) defaults the exposed name to `workflow`.
- **Successful restriction still admits workflow:** [src/worker/preset.ts:175–195](<C:/Users/TZ/Desktop/dsh-bot/src/worker/preset.ts#L175-L195>) reads the scoped names, resolves the deny filter and applies `tools.restrict({ deny })`. [src/worker/tool-barrier.ts:16–73](<C:/Users/TZ/Desktop/dsh-bot/src/worker/tool-barrier.ts#L16-L73>) denies named orchestration tools, including `await_agent`, and spreads the shared spawn candidates. [src/core/tools.ts:694–698](<C:/Users/TZ/Desktop/dsh-bot/src/core/tools.ts#L694-L698>) lists only `subagent`, `subagent_fork` and `list_subagent_models`; neither candidate list contains `workflow`.
- **The calling worker becomes the workflow parent:** [dsh-tool-workflow/lib/index.js:385–405](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-workflow/lib/index.js#L385-L405>) takes `parent = exec.agent`, checks that an agent exists, and starts the engine with that parent; it has no delegated-worker refusal. [dsh-workflow-ptc/lib/index.js:624–648](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-workflow-ptc/lib/index.js#L624-L648>) validates metadata/script and constructs the run using `request.parent` without a worker-leaf check.
- **Direct activation has no leaf ceiling:** [dsh-workflow-ptc/lib/index.js:327–348](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-workflow-ptc/lib/index.js#L327-L348>) calls `subagents.startActivation` with `request.parent = this.parent`, `delivery: "caller"` and no `maxDepth`. [dsh-subagent/lib/index.js:3051–3062](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js#L3051-L3062>) requires the exact live parent identity, which the worker supplies, but does not enforce the plugin's worker-leaf permission. [local creation:1397–1406](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js#L1397-L1406>) passes the new request's `maxDepth` to [dsh-subagent/lib/types/child-agent.js:31–39](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/types/child-agent.js#L31-L39>), which bounds depth only when a ceiling is provided. The original worker spawn's [request-level ceiling:3678–3688](<C:/Users/TZ/Desktop/dsh-bot/src/adapter/cordis-dsh-host.ts#L3678-L3688>) is not a persistent ceiling on this new request.
- **Plugin accounting and denied await names are bypassed:** [src/adapter/cordis-dsh-host.ts:3712–3736](<C:/Users/TZ/Desktop/dsh-bot/src/adapter/cordis-dsh-host.ts#L3712-L3736>) reserves/registers the tracked worker before its activation. The workflow engine's direct service call does not traverse that path. [dsh-tool-workflow/lib/index.js:414–421](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-workflow/lib/index.js#L414-L421>) awaits the workflow result and returns its value to the caller; the script can receive a child's result without invoking denied `await_agent` or native spawn tools.

## Static reproduction (do not execute for this filing)

1. Use the inspected host with the plugin active and a worker inheriting the standard preset, with no independent child preset replacing the workflow capability. Let normal worker composition and restriction succeed.
2. From that worker's scope, the remaining `workflow` tool accepts the following arguments. Its required metadata fields are documented at [dsh-tool-workflow/lib/index.js:274–294](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-workflow/lib/index.js#L274-L294>):

   ```json
   {
     "meta": {
       "name": "leaf-check",
       "description": "Inspect X and return a summary"
     },
     "script": "const result = await agent(\"Inspect X and summarize\"); return { result };"
   }
   ```

3. Follow the confirmed route: worker tool scope → `workflow.execute` → workflow engine → `startChild` → host `startActivation`. A worker-leaf check should refuse before descendant activation. The inspected route instead admits the live worker as parent, omits the new request's depth ceiling and returns the script result through the workflow tool.

This is a static reproduction description, not an observed live run. The example was not executed.

## Scope and duplicate check

The confirmed route is specific to the inspected `0.2.2-rc.1` installation and the standard inherited preset's `workflow-ptc` spawn provider. Custom profiles, independently selected child presets, other providers and other host versions were not checked. Host sandbox, cancellation and resource limits still apply; they do not enforce this plugin's worker-leaf rule.

All-status searches for `workflow-ptc`, `tool-workflow` and workflow/worker-leaf/barrier combinations were empty and repeated immediately before creation, including untracked concurrent tickets. Numeric prefix 182 was free across every status folder at that check. [Ticket 178](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/178-replace-spawn-worker-with-native-subagent.md>) and [ticket 179](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/179-dispatcher-surface-withholds-native-spawn-verbs.md>) address raw native spawn verbs; [ticket 176](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/176-spawned-dispatcher-cannot-summon.md>) addresses the spawned-dispatcher class's summon scope. [Ticket 200](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/open/200-worker-composition-failure-keeps-unrestricted-worker-live.md>) addresses exceptional composition failure. This issue concerns a retained workflow capability after successful worker restriction.

## Acceptance criteria

- [ ] Deny the workflow agent-orchestration capability to worker scopes, or have the host reject worker callers before any workflow descendant activation. Enforce the capability boundary rather than relying on prompt instructions or the original spawn request's depth ceiling.
- [ ] Preserve dispatcher availability intentionally: the fix must explicitly distinguish worker scope from authorized dispatcher scope and avoid an accidental blanket dispatcher ban.
- [ ] Add a focused check for a worker inheriting the mounted standard workflow capability: native spawn verbs and `await_agent` being denied must not leave script-level `agent()` usable. Pin the worker refusal and intentional dispatcher behavior, including no child activation on the worker path.

## Validation and limits

The primary reviewer and a separate independent validator confirmed the same static route before filing, as supplied in the filing handoff. The ticket author re-read the cited short repository and installed-host ranges, confirmed the installed version, and repeated all-status duplicate/prefix checks. No tests, builds, live workflow/subagent calls, or reproduction execution were performed. Only this new issue is written; implementation, configuration, documentation and index changes are outside this filing.

## Comments

- 2026-11-07 — Filed as one high-severity ship blocker with the profile/provider and static-validation limits above. Primary review and independent validation agree on the workflow route; no broader host-compromise or unrelated-user-messaging claim is made.

## Resolution - 2026-11-08

Fixed in `9423a1e`: `workflow` is added to the worker deny candidates in `src/worker/tool-barrier.ts` while dispatchers keep it; `test/worker-agent-type.test.ts` passes 25/25.
