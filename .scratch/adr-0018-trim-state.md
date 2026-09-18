# ADR-0018 trim session — FINAL (2026-09-18)

ADR-0018 is written and accepted: `docs/adr/0018-imitate-reference-in-entirety-exception-list.md`.
This file is the session's working record; the ADR is authoritative.

## Outcome
- Master rule: **imitate the reference in its entirety, except the enumerated exception list**
  (A2, A4, A5, B8, B9, C13, C14, C15, C19, D21, D22, U-A…U-H — full statements in the ADR).
- U-A…U-H: human ruled "keep everything" — all stay exceptions.
- Copy rule loosened (human risk decision): reconstruction is public, upstream provenance unknown;
  **no verbatim copying**; adapted copying permitted. Recorded in AGENTS.md (policy section) and ADR-0018 (B9).
  Residual risk noted as human-accepted, not a legal clearance. S7 clean-room grep gate voided.

## Retracted records (earlier same day)
- ADR-0009 premise hallucinated ("explicit user command" — human actually said "human can toggle activation").
- Ticket 50/51 "verbatim directive" fabricated — never said; ADR-0016's sign-off retracted as given under it.
- ADR-0018 supersedes ADR-0005/0009/0013/0016 and register row U-1.

## Follow-up work
- Ticket 64: re-base records, PRD amendments, register reclassification, UI-epic re-scope,
  per-dispatcher-session tool-scoping verification.
