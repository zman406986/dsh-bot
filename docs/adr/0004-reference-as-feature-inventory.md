# Reference is a feature inventory, not a build list

**Status:** accepted

The reference implementation is an **inventory source of features**, not an automatic build list. Inventory its capabilities first, then adopt only those that serve the product goal and S1–S9; deliberately skip the rest (e.g. remote computer use and similar out-of-scope tooling). Reference behavior stays authoritative for *how an adopted feature behaves*; *which* features exist is decided against the product goal, not by parity.

## Context

- AGENTS.md "Source of truth": for behavior the PRD leaves open, implementers observe the reference and imitate it. Q4 asked where that imitation authority ends — behavior of in-scope features only, or also authority to build features the PRD never mentions (permission/secret prompts, artifact delivery, memory across restarts, extra wake sources, dispatcher context hygiene)?
- Human's answer (verbatim): "inventory features first, match ones we need to achieve product goal, skip useless ones like remote computer use and stuff."
- The reference inventory already exists: `docs/research/prd-vs-reference-capability-gaps.md` (capability areas, directory/module level, no source/prompts/identifiers copied). It confirms the PRD covers the dispatch loop and lists the surrounding areas as gaps.
- Prior ADRs used reference observation for *behavior* (ADR-0003) but never stated whether it also authorizes *scope*.

## Considered options

| Option | Rejected because |
|---|---|
| **A. Inventory, then adopt only what serves the product goal (S1–S9); skip the rest** | **Chosen.** Bounds imitation to behavior of adopted features; keeps scope decisions accountable to the product goal and the success criteria. |
| B. Behavior-only silence — reference says nothing about *which* features exist | Leaves recurrence: every unbuilt capability (memory, artifacts, timers) re-asks the human; also fails to say the inventory is worth doing. |
| C. Full parity build — build everything the reference has | Rebuilds out-of-scope tooling (remote computer use, sandbox, UI) and burns scope on features S1–S9 never ask for; contradicts AGENTS.md non-goals. |

## Consequences

- Scope authority: the product goal + S1–S9 decide which features exist; the reference never does. Log skipped capabilities with the reason, so they are deliberate no-s, not oversights.
- Behavior authority is unchanged: once a feature is adopted, reference behavior is still the tiebreaker (ADR-0003, behavior notes).
- The inventory (plain-language, path citations only) lives in `docs/research/`; `prd-vs-reference-capability-gaps.md` is the current one. No reference source, prompts, tool strings, identifiers, or protocol artifacts may be copied into it.
- AGENTS.md open-decisions line amended (see line 33); PRD §15.6 was resolved separately by ADR-0005.