# 14 — Peer inbox + priority lane

**What to build:** Other assistants can reach this dispatcher asynchronously, and the user can never be interrupted by them. A peer message arrives later as its own turn, identified as another assistant rather than the user.

**Blocked by:** 12 — Feature flag + profile split.

**Status:** ready-for-agent

- [ ] A peer agent can send a message to the dispatcher without waiting for a reply; the send returns a delivery acknowledgement only.
- [ ] A peer message arrives as a fresh hidden turn with a cue that it comes from another assistant, never as the user.
- [ ] A non-priority peer message queues behind the user's current work and ahead of background work.
- [ ] A priority peer message goes to the front of the inbound queue and interrupts an active non-user run.
- [ ] A priority peer message never interrupts a turn the user is driving; if the active run is the user's, no interrupt happens.
- [ ] Non-user work interrupted by a priority message is re-queued rather than lost, with no duplicate delivery.
- [ ] The peer envelope carries a sender identity, a target that may be a single agent or a group/broadcast target, and a conversation identifier.
- [ ] Group targets ignore priority: a group post queues normally and the sender is told priority did not interrupt the members.