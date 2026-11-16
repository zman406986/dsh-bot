import { assembleTurnReminder, renderPeerRoster } from "../src/core/policy/assembler.ts";
const empty = assembleTurnReminder([]);
console.log("=== EMPTY ROSTER REMINDER (JSON) ===");
console.log(JSON.stringify(empty));
console.log("=== EMPTY ROSTER REMINDER (text) ===");
console.log(empty);
console.log("=== NON-EMPTY ROSTER SECTION (JSON) ===");
console.log(JSON.stringify(renderPeerRoster({ peers: [{ sessionId: "session-2", label: "Research scout", liveness: "idle" }] })));
