import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skillSource = await readFile(
  new URL("../skills/manage-taskboard/SKILL.md", import.meta.url),
  "utf8",
);

test("the taskboard skill coordinates safe issue execution and review handoff", () => {
  assert.match(skillSource, /默认的 `issue list`.*不返回 `done` 和 `canceled`/is);
  assert.match(skillSource, /50 个字符的 `descriptionPreview`/i);
  assert.match(skillSource, /活跃候选看起来相关或无法确定.*`issue brief`/is);
  assert.match(skillSource, /`--all-statuses --full`.*统计、导出或诊断/is);
  assert.match(skillSource, /运行一次 `issue brief`.*最新任务内容、全部评论/is);
  assert.match(skillSource, /已交付工作被退回修改/i);
  assert.match(skillSource, /认领 `todo`.*`--if-version`.*`in_progress`/is);
  assert.match(skillSource, /版本冲突.*跳过该任务.*不要实施/is);
  assert.match(skillSource, /已经是 `in_progress` 且负责人是当前 Agent.*不要再次移至/is);
  assert.match(skillSource, /只有需要.*命令或选项时.*读取 \[references\/cli\.md\]/is);

  assert.match(skillSource, /每轮新反馈至多一条 `用户反馈：` 评论/is);
  assert.match(skillSource, /每次交付一条 `交付：` 评论/is);
  assert.match(skillSource, /一条 `需决策：` 或 `阻塞：` 评论/is);
  assert.match(skillSource, /约 300 个中文字符.*可以超过/is);
  assert.match(skillSource, /省略原始日志、逐步探索过程.*逐文件 diff/is);
  assert.match(skillSource, /添加 `交付：` 评论并把任务移至 `in_review`/i);
});
