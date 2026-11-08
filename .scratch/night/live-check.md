# Live check — titles and model option (isolated instance)

Date: 2026-11-08 ~06:05 (+08:00). Written by the summoned team leader.
Result: all three checks passed in a real running dsh, in a throwaway instance. The owner's instance was not touched.

## Instance

- Repo built first: `npm run build` (exit 0, at `71c956d`).
- Port: **3099**. Home: `C:\Users\TZ\Desktop\dsh-bot\.scratch\night\live\home2` (fresh, created for this).
- Command: `node <installed dsh>/lib/bin.js --profile web --patch dev/cordis.web.patch.yml --no-open --port 3099`
- Env: `DSH_HOME=<that temp home>`, `DEEPSEEK_BASE_URL=http://127.0.0.1:<mock>/v1`, `DEEPSEEK_API_KEY=mock-key-not-a-secret`, telemetry disabled.
- Model endpoint: `dev/mock-llm.mjs`, scripted; no provider call, no network beyond 127.0.0.1. Script at `live/mock-script.json`, request log at `live/mock-requests2.jsonl`, host log at `live/dsh2.log`.
- Driver: `live/live-check2.mjs` (host RPC: `session/create`, `commands/execute /dsh-bot`, `session/selectModel`, `session/prompt`).

The parent chat was put on **deepseek-v4-pro** so a leader explicitly set to a different model is observable; the fallback leader should inherit the parent route.

## Check (a) — a summoned leader gets a real title

Prompt 1 told the dispatcher to call `spawn_dispatcher` with `title: "Night live title probe"` and `model: "deepseek-flash"`.

- Leader id `0536e052-4bbe-4728-9207-af1c35671e6e`.
- Real title, read from that session's projection (`storages/session_projcache/sessions/0536e052...json`, row `title`): **"Night live title probe"**.
- The tool result confirms the title in its first line: `Summoned "Night live title probe" as a peer dispatcher`.

## Check (b) — a valid explicit model reaches the leader

- Parent `session-0eab8e02...`: `modelSelection.lastUsed = {provider: "deepseek-official", model: "deepseek-v4-pro"}`.
- Leader `0536e052...`: `modelSelection.lastUsed = {provider: "deepseek-official", model: "deepseek-flash"}`.
- The leader's own first turn was served by the mock with model `deepseek-flash` (mock log), and its tool result carried no fallback note.

## Check (c) — a nonsense model still creates the team, warns once, and reports a fallback

Prompt 2 called `spawn_dispatcher` with `title: "Night live fallback probe"`, `model: "nonsense/nope"`.

- Leader id `da542427-ec88-4e01-8c1f-8887df983831` was still created; title row is **"Night live fallback probe"**.
- Its `modelSelection.lastUsed = {provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "high"}` — the parent's route, as designed.
- Exactly one warning in the host log:
  `[multitask-dispatcher] model option "nonsense/nope" from session session-0eab8e02... was ignored (unknown model); using the summoner's current route.`
- The tool result ends with: `Leader model "nonsense/nope" was not used (not in the model catalog); the summoned dispatcher uses your route.`

## Teardown and owner instance

- Both children killed with `taskkill /T /F`; port 3099 has **0 listeners**; no `mock-llm`/`live-check` node processes remain.
- Owner's instance on 3080: PID **14920**, started **2026-11-07 19:48:38**, still the only listener, HTTP **401** (alive, auth required). Never restarted, never written to.
- The temp home is disposable; it holds only mock-model sessions.

## Notes

- Titles were read from the stored session projection, not from a browser: this is the same row the sidebar renders.
- Model selection was read from `modelSelection.lastUsed` after the leader's first turn, so it reflects what actually ran, not just the spawn request.
- The fallback leader inherits `reasoningEffort`; the explicit-model leader does not. That matches the ADR's leader-path rule.
