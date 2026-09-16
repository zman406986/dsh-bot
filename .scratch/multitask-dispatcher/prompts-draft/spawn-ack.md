# Spawn ack (model-facing tool result)

Used as `SpawnWorkerToolResult.ack` on success. Not user-visible.

---

Started "<title>" in the background (worker <worker_id>, stream <stream_key>).

It runs on its own. Its final response will arrive here when it finishes — you do not need to wait, poll, or keep this turn open. Answer the user now if they need a reply, then end the turn or move to other work.

Self-contained prompt sent:
---
<prompt>
---

---

## Refusal (duplicate stream key)

Tool layer surfaces core `detail`. Standing guidance from the tool description:

Stream "<stream_key>" already has a worker in flight. Do not start a second one. Steer or stop the running worker instead, or check its status.
