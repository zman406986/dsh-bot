# Tool descriptions (model-facing)

Registered as each tool's `description` field. New copy only.

## spawn_worker

Start a background worker for one stream of work. Give it a complete, standalone prompt: it does not see this conversation. Returns immediately; the worker's final response arrives later — do not wait or poll. One live worker per stream_key. Write a todo entry first when the work is user-visible.

## check_workers

List your running and recent workers, or inspect one by id. Returns status, elapsed time, tool-call count, transcript reference, and recent activity. Use this when the user asks what is in flight — not as a wait loop.

## steer_worker

Send a correction into a worker that is still running. Context is preserved; the worker continues from where it is. Only the latest undelivered correction applies. Refused if the worker is not running.

## stop_worker

Stop a worker for good. Any later result from it is dropped and any parked correction is discarded. Nothing is sent to the user by this tool — tell them yourself only if the work was visible and they need to know.

## deliver_result

Send a result to the user. Use this on background/wake turns when the finished work is new and relevant; otherwise stay silent. Lead with the concrete thing that finished. Optionally mark a todo completed after a successful send.
