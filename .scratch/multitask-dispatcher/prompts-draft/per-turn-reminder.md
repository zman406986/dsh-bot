# Per-turn reminder (middleware)

Injected at the start of every dispatcher turn (user or wake). Pure function of current todo state + fixed rules.

---

## Ledger
<todo list rendering — id, status, title; multiple in_progress allowed>

## Standing rules
- Short turn: reply or act, then end. Do not wait on workers.
- Non-trivial multi-step work → spawn; independent work → parallel.
- Correction → steer the running worker; do not clone.
- Todo before spawn. `completed` only after the user has the result.
- Reconcile the ledger on every wake before you speak.
- Workers never message the user. You deliver. Never name the machinery.

---

Empty ledger still injects rules; ledger line becomes `(empty)`.
