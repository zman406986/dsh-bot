import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WAKE_RE_PRESENTED_INTRO,
  WAKE_RE_PRESENTED_INTRO_ZH,
  buildStandingRulesBlock,
  buildWakeInstructionsBlock,
  type PolicyLanguage,
} from "../src/core/policy/prompts.js";

/**
 * Close-on-silence (change 1 of 3): a stale/duplicate result must close its
 * ledger entry in the same turn instead of ending the turn with the entry
 * open; an open entry comes back on the next wake.
 *
 * The standing-rules literals below were captured from the pre-change build
 * (buildStandingRulesBlock EN/ZH, chief + team leader) and must stay
 * byte-identical: this change touches only the wake copy, never the standing
 * rules or their helpers.
 */

const STANDING_EN_USER =
  "## Standing rules\n- All non-trivial work, including planning, goes to a worker you start with `subagent` (an independent small item suitable for one-shotting) or a team (all multi-step work). Convey fast; do not plan for them.\n- Keep turns short: reply or act, then end the turn. Do not wait or poll — a worker's completion notice starts a new turn and carries its closing message.\n- Tell the user what you are doing before you do it.\n- A correction is `send_message` to the worker, not a cloned worker.\n- Plain and concise language, no jargon. Name the actual outcome instead of a vague success claim.\n- Update the ledger and keep it lean.";

const STANDING_EN_SPAWNED =
  "## Standing rules\n- Chunk down tasks as much as you can, run as many lanes in parallel as you can. If any task can be run in parallel chunks, do that instead of giving to a single agent.\n- Keep turns short: dispatch or re-chunk, then end the turn. Do not wait or poll — a worker's completion notice starts a new turn and carries its closing message.\n- A correction is `send_message` to the worker, not a cloned worker. When a part is running and the direction changes, send it the new direction.\n- Plain and concise language, no jargon. Lead with what is now unblocked, not \"it worked\".\n- Update the ledger and keep it lean. It is how you see what is running, what is parked, and what still needs splitting.";

const STANDING_ZH_USER =
  "## 常设规则\n- 所有非琐碎的工作，包括规划，都交给你用 `subagent` 启动的工作者（一件可以一次做完的独立小事）或团队（所有多步工作）。传达要快；不要替它们做规划。\n- 回合要短：回答或动手，然后结束回合。不要等待，也不要轮询——工作者的完成通知会开启新回合，并带上它的收尾消息。\n- 在做之前先告诉用户你要做什么。\n- 修正就是用 `send_message` 给那个工作者发消息，不是复制一个工作者。\n- 语言平实简洁，不用行话。直接说实际结果，不要用笼统的成功说法。\n- 更新账本，并保持精简。";

const STANDING_ZH_SPAWNED =
  "## 常设规则\n- 任务切得越细越好，能并行的通道开得越多越好。任何任务只要可以拆成并行的几块，就这样做，不要整块交给一个代理。\n- 回合要短：派发或重新切分，然后结束回合。不要等待，也不要轮询——工作者的完成通知会开启新回合，并带上它的收尾消息。\n- 修正就是用 `send_message` 给那个工作者发消息，不是复制一个工作者。某一块正在运行而方向变了，就把新方向发给它。\n- 语言平实简洁，不用行话。开头先说现在什么被解锁了，不要说“它跑通了”。\n- 更新账本，并保持精简。它让你看到什么在运行、什么在停放、什么还需要再切分。";

const CLOSE_CALL = '`deliver_result(todo_id=..., text="<one-line reason>")`';

const numberedLines = (text: string): number =>
  text.split("\n").filter((line) => /^\d+\. /.test(line)).length;

describe("close-on-silence wake copy", () => {
  it("buildStandingRulesBlock stays byte-identical (EN/ZH, chief and team leader)", () => {
    assert.equal(buildStandingRulesBlock("en", "user"), STANDING_EN_USER);
    assert.equal(buildStandingRulesBlock("en", "spawned"), STANDING_EN_SPAWNED);
    assert.equal(buildStandingRulesBlock("zh", "user"), STANDING_ZH_USER);
    assert.equal(buildStandingRulesBlock("zh", "spawned"), STANDING_ZH_SPAWNED);
    // Defaults still select the chief-of-staff EN face, byte for byte.
    assert.equal(buildStandingRulesBlock(), STANDING_EN_USER);
  });

  it("both wake faces close stale/duplicate results in the same turn (EN)", () => {
    const chief = buildWakeInstructionsBlock("en", "user");
    const leader = buildWakeInstructionsBlock("en", "spawned");

    for (const [name, text] of [
      ["chief", chief],
      ["team leader", leader],
    ] as const) {
      assert.ok(
        text.includes("stale, duplicate, or not worth telling the user"),
        `${name}: the stale/duplicate trigger is missing`,
      );
      assert.ok(text.includes(CLOSE_CALL), `${name}: the close call is missing`);
      assert.ok(
        text.includes("and do not state it to the user"),
        `${name}: silence for the user is not stated`,
      );
      assert.ok(
        text.includes(
          "an entry left open is re-presented on the next wake",
        ),
        `${name}: the consequence of an open entry is missing`,
      );
      assert.ok(
        text.includes("— provided the entry is closed."),
        `${name}: silence no longer means a closed entry`,
      );
    }

    // The chief face says it in its decide step; the leader folds it into its
    // matching step. Step counts stay six and five.
    assert.ok(chief.includes("Stay silent and end the turn if it is stale"));
    assert.ok(
      leader.includes(
        "A settle closes one part, not the job. If a result is stale",
      ),
    );
    assert.ok(chief.includes("Silence is a valid outcome — provided the entry is closed."));
    assert.ok(
      leader.includes(
        "Silence is a valid outcome only when nothing changed for anyone above you — provided the entry is closed.",
      ),
    );
    assert.equal(numberedLines(chief), 6);
    assert.equal(numberedLines(leader), 5);
  });

  it("both wake faces close stale/duplicate results in the same turn (ZH)", () => {
    const chief = buildWakeInstructionsBlock("zh", "user");
    const leader = buildWakeInstructionsBlock("zh", "spawned");

    for (const [name, text] of [
      ["chief", chief],
      ["team leader", leader],
    ] as const) {
      assert.ok(
        text.includes("已经过时、重复，或者不值得告诉用户"),
        `${name}: the stale/duplicate trigger is missing`,
      );
      // The tool call stays a literal identifier, unchanged across languages.
      assert.ok(text.includes(CLOSE_CALL), `${name}: the close call is missing`);
      assert.ok(
        text.includes("不要对用户提起"),
        `${name}: silence for the user is not stated`,
      );
      assert.ok(
        text.includes("没有关闭的条目会在下一次唤醒时再次呈现"),
        `${name}: the consequence of an open entry is missing`,
      );
      assert.ok(
        text.includes("——前提是条目已经关闭。"),
        `${name}: silence no longer means a closed entry`,
      );
    }

    assert.ok(chief.includes("沉默是有效的结果——前提是条目已经关闭。"));
    assert.ok(
      leader.includes(
        "只有在上层没有任何人因此发生变化时，沉默才是有效的结果——前提是条目已经关闭。",
      ),
    );
    assert.equal(numberedLines(chief), 6);
    assert.equal(numberedLines(leader), 5);
  });

  it("re-presented intro tells the model to deliver now or close silently now (EN/ZH)", () => {
    assert.ok(
      WAKE_RE_PRESENTED_INTRO.includes(
        "deliver it now, or close it silently now; do not leave it open",
      ),
    );
    assert.ok(!WAKE_RE_PRESENTED_INTRO.includes("deliver it or stay silent"));
    assert.ok(
      WAKE_RE_PRESENTED_INTRO.startsWith(
        "These results were already shown in an earlier wake and are still not delivered. Treat them as re-presented, not as new settles; use each report below to decide whether ",
      ),
    );

    assert.ok(
      WAKE_RE_PRESENTED_INTRO_ZH.includes(
        "现在送达，还是现在静默关闭；不要让它一直开着",
      ),
    );
    assert.ok(!WAKE_RE_PRESENTED_INTRO_ZH.includes("送达还是保持沉默"));
    assert.ok(
      WAKE_RE_PRESENTED_INTRO_ZH.startsWith(
        "这些结果在之前的唤醒里已经展示过，目前仍未送达。把它们当作再次呈现，而不是新的结束；根据下面的报告决定是",
      ),
    );
  });

  it("EN and ZH wake faces keep the same line shape per class", () => {
    const languages: PolicyLanguage[] = ["en", "zh"];
    for (const language of languages) {
      assert.equal(
        buildWakeInstructionsBlock(language, "user").split("\n").length,
        buildWakeInstructionsBlock("en", "user").split("\n").length,
        `${language}: chief line shape drifted`,
      );
      assert.equal(
        buildWakeInstructionsBlock(language, "spawned").split("\n").length,
        buildWakeInstructionsBlock("en", "spawned").split("\n").length,
        `${language}: team-leader line shape drifted`,
      );
    }
  });
});
