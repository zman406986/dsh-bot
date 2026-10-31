import type { Operation, Removal } from "../rules/types.js";
import type { Episode } from "../episodes/types.js";
import type { CheckContext, Report } from "./context.js";
import { sameRanges } from "./bytes.js";

export function checkEpisode(
  c: CheckContext, op: Operation, removal: Removal | undefined, report: Report,
): Episode | undefined {
  if (op.kind !== "seal") return undefined;
  const episode = c.episodes.find(e => e.id === op.episodeId);
  if (episode === undefined) {
    report("episode-evidence-missing", `No independently detected episode ${op.episodeId}`);
    return undefined;
  }
  if (episode.status !== "closed") report("episode-open", "Episode has not closed");
  if (c.value.sealedEpisodeIds.includes(episode.id)) {
    report("invalid-plan", "Episode already has a committed seal");
  }
  if (episode.closedAtTurn !== null
    && c.value.snapshot.currentTurnOrdinal - episode.closedAtTurn > c.value.config.thresholds.sealMaxLatencyTurns) {
    report("late-seal", "Seal exceeds the configured turn latency");
  }
  const misses = episode.missNodeIds.map(id => c.nodes.get(id));
  if (misses.length === 0 || episode.target.key.trim() === "" || episode.target.label.trim() === ""
    || misses.some(n => n === undefined || n.kind !== "tool-result"
      || n.evidence.target?.key !== episode.target.key || n.evidence.paths.length === 0
      || n.evidence.paths.some(p => p.outcome !== "miss" || p.pathKey.trim() === "" || p.displayPath.trim() === ""
        || (p.lineCount !== null && (!Number.isSafeInteger(p.lineCount) || p.lineCount < 0))
        || (p.byteLength !== null && (!Number.isSafeInteger(p.byteLength) || p.byteLength < 0))))) {
    report("episode-evidence-missing", "Negative fact lacks explicit target and valid miss-path evidence");
  }
  if (op.mode === "replace" && removal !== undefined) {
    const actual = removal.sources.map(s => s.source.nodeId).sort();
    const expected = [...episode.missNodeIds].sort();
    if (actual.length !== expected.length || actual.some((id, i) => id !== expected[i])) {
      report("unaccounted-removal", "Replace seal must name exactly the detected miss bodies");
    }
    for (const source of removal.sources) {
      const n = c.nodes.get(source.source.nodeId);
      if (n !== undefined && !sameRanges(source.ranges, [{ startByte: 0, endByteExclusive: n.bytes.length }])) {
        report("unaccounted-removal", "Replace seal must remove each eligible miss body whole", n.id);
      }
    }
  }
  if (removal !== undefined) for (const source of removal.sources) {
    if (episode.hitNodeIds.includes(source.source.nodeId)) {
      report("hit-removal", "Operation attempts to remove an episode hit", source.source.nodeId);
    }
    if (episode.unknownNodeIds.includes(source.source.nodeId)) {
      report("episode-evidence-missing", "Seal cannot remove unknown evidence", source.source.nodeId);
    }
  }
  return episode;
}
