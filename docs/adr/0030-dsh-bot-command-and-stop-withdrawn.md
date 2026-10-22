# The activation command is /dsh-bot and /dispatcher-stop is withdrawn — the human's 2026-10-21 ruling

**Status:** accepted (human-ruled, 2026-10-21 in-session directive) — supersedes the command NAME in ADR-0009's explicit-activation path (`dispatcher-start` → `dsh-bot`; ADR-0009's substance — explicit command activation, no capture on load — stands); withdraws ADR-0021 decision 3's `/dispatcher-stop` command transport (its client affordance was already withdrawn by 0024) and ADR-0024 decision 2's `/dispatcher-start` phrasing on this point; ADR-0021 decision 3's add/delete permission stands as retained internal machinery; mitosis proceeds under ADR-0025 unchanged

**Numbering:** 0030, the first free number at filing (2026-10-21; highest in use was 0029). Filed by the records pass for the 2026-10-21 in-session human ruling; implementation is ticketed separately as tickets 128 and 129 per repo rule.

**Supersedes wherever conflicting:** ADR-0009's command NAME only — the explicit-activation path it records is the live mechanism and now runs under the name `dsh-bot`; the substance (explicit command activation, no capture on load, deferred parent binding) stands. ADR-0021 **decision 3's command transport** — the `/dispatcher-stop` command (ticket 101) — is withdrawn; decision 3's add/delete PERMISSION stands as retained internal machinery, exactly as 0024 left it after withdrawing the client affordance. ADR-0024 **decision 2's `/dispatcher-start` phrasing** is superseded on the name only; every other decision of 0024 stands.

**Evidence:** the human's in-session ruling of 2026-10-21, quoted verbatim (the `"/dsh-bot"` quoting is from the live message):

> continue work on open issues, and 1 turn dispatcher-start into "/dsh-bot" 2 remove dispatcher-stop 3 build mitosis

The premise is the human's own live ruling as relayed to this records pass — nothing reconstructed (the ADR-0016 fabricated-premise rule; same posture as ADR-0021/0022/0024's evidence notes). The ruling's items map: item 1 = ticket 128 (rename), item 2 = ticket 129 (remove the stop command), item 3 = mitosis (already decided and ticketed — see Decision 3). "Continue work on open issues" is direction to execute the filed queue, not a new decision, and is recorded here only because it is part of the verbatim quote. Codebase facts establishing the state the ruling changes (verified 2026-10-21 at filing): the activation command name constant is `DISPATCHER_START_COMMAND = "dispatcher-start"` (`src/adapter/activation-command.ts:19`), registered at `src/plugin.ts:1212`; the stop command is `DISPATCHER_STOP_COMMAND = "dispatcher-stop"` (`src/adapter/stop-command.ts:39`), registered at `src/plugin.ts:1278`; the stop handler runs the SAME deactivation the host `agent/disposed` listener runs — `lifecycle.deactivate` → the internal `deactivateSession` sequence — so it adds no deactivation semantics of its own and its removal deletes none.

## Decision

1. **The activation command is `dsh-bot`**, invoked as `/dsh-bot`. ADR-0009's explicit-activation path stands unchanged in substance — the command is still the only opt-in, activation still defers the parent binding, there is still no capture on load. The former `dispatcher-` prefix convention no longer binds this command's name: the human's chosen name governs, and the constant's prefix comment is updated with the value.
2. **`/dispatcher-stop` is withdrawn.** `src/adapter/stop-command.ts` and its `plugin.ts` registration are removed; every test pinning the command is removed or re-based. The lifecycle deactivation machinery is **kept for internal teardown**: `lifecycle.deactivate` and the host `agent/disposed` teardown path stay, and a dispose-path deactivation behaves exactly as before. This withdraws the last user-facing delete affordance for a dispatcher session — ADR-0021 decision 3's client affordance was already withdrawn by ADR-0024, and this removes the command transport too — so deactivation now happens only implicitly (host disposal or plugin unload). The dsh chat itself was never disposed from our code (ADR-0021's own conservative terms) and still is not.
3. **Mitosis proceeds under ADR-0025 unchanged.** The ruling's "build mitosis" is direction to execute what is already decided and ticketed: ADR-0025 plus tickets 115–118 cover it. No new mitosis ticket is filed and no new mitosis ADR is drafted; this ADR adds nothing to and duplicates nothing of ADR-0025.

## Context

Authority stack: a dated human explicit override is level 1 and sits above accepted ADRs (level 2). It is recorded here as a human-ruled ADR per the ADR-0021/0022/0024 precedent so the supersessions are explicit rather than silent, and so accepted-ADR bodies stay untouched (the recorded 2026-09-19/09-20 convention: dated notes on Status lines and the index rows, never body edits).

Vocabulary note: `CONTEXT.md` marks "bot" as an avoid-word for the **peer agent** concept, and ADR-0021 decision 5 keeps it out of repo prose. `dsh-bot` is not that vocabulary reintroduced: it is the human's explicitly chosen command identifier, quoted from the ruling — a proper name, not prose. Prose continues to say "dispatcher session".

## Considered options

| Option | Rejected/kept because |
|---|---|
| Keep `/dispatcher-start` | **Rejected** — contradicts the ruling verbatim. |
| Rename and also change activation behavior | **Rejected** — the ruling names the command only; substance stands. |
| Remove the stop command AND the deactivation machinery | **Rejected** — the ruling removes the user-facing command; the teardown machinery is internal (host disposal runs it) and removing it would break teardown. Only the command goes away. |
| Keep `/dispatcher-stop` but hide it | **Rejected** — "remove dispatcher-stop" is explicit. |
| File a new mitosis ticket / draft a new mitosis ADR | **Rejected** — duplication; ADR-0025 + tickets 115–118 already cover it. |

## Consequences

- Tickets 128 (rename) and 129 (stop-command removal) are the implementation lane. Tests pinning the literal names (`test/activation-lifecycle.test.ts:483,486`, `test/stop-command.test.ts:249`) and the constants are re-based or removed by them.
- ADR-0009's, ADR-0021's, and ADR-0024's **Status:** lines and the ADR README's rows carry dated notes per the recorded convention; accepted-ADR bodies stay untouched.
- `docs/surfaces.md`'s inventory rows for both commands (243/244/255 and the line-84 worker-stop scoping note) are corrected by the tickets. The PRD and repo README name neither command (verified 2026-10-21 at filing).
- `src/adapter/session-kind-projection.ts` keys session-kind detection partly on both command names; with the stop command gone its `DISPATCHER_STOP_COMMAND` branch is re-based (ticket 129).
- `test/restart-honesty.test.ts`'s structural guard ("no stop/cancel command except `/dispatcher-stop`") becomes strictly stronger: no stop/cancel command at all.
- A user leaves a dispatcher session only by disposing the chat (a dsh-native action) or by plugin unload. If the owner later wants an explicit way out, that is a new dated ruling and a new ticket — not a silent revival of the withdrawn command.

## Traceability

- ADRs: 0009 (command NAME superseded; substance stands), 0021 (decision 3's command transport withdrawn; permission stands as retained machinery), 0024 (decision 2's `/dispatcher-start` phrasing superseded on the name; decisions otherwise stand), 0025 (mitosis — stands unchanged, executed by its existing tickets).
- Tickets: 128 and 129 (implementation, filed with this ADR), 115–118 (mitosis — already filed, no duplicates), 101 (filed the stop command — now withdrawn), 19 (filed the activation command — renamed).
