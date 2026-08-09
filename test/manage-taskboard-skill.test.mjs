import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skillSource = await readFile(
  new URL("../skills/manage-taskboard/SKILL.md", import.meta.url),
  "utf8",
);

test("the taskboard skill coordinates safe issue execution and review handoff", () => {
  assert.match(skillSource, /default `issue list`.*omits `done` and `canceled`/is);
  assert.match(skillSource, /50-character `descriptionPreview`/i);
  assert.match(skillSource, /candidate looks related or ambiguous.*`issue brief`/is);
  assert.match(skillSource, /`--all-statuses --full`.*statistics, export, or diagnosis/is);
  assert.match(skillSource, /`issue brief` once to read the latest issue content, all comments/i);
  assert.match(skillSource, /completed work.*returned|returned.*completed work/i);
  assert.match(skillSource, /claim.*`todo`.*`in_progress`.*`--if-version`/is);
  assert.match(skillSource, /version conflict.*skip the issue.*do not implement/is);
  assert.match(skillSource, /already `in_progress` and assigned to the running agent.*without moving/is);
  assert.match(skillSource, /read \[references\/cli\.md\].*only when you need another command/is);

  assert.match(skillSource, /at most one `用户反馈：` comment per new feedback round/is);
  assert.match(skillSource, /one `交付：` comment per delivery/is);
  assert.match(skillSource, /one `需决策：` or `阻塞：` comment/is);
  assert.match(skillSource, /about 300 Chinese characters.*exceed that when the next session needs the detail/is);
  assert.match(skillSource, /omit raw logs.*step-by-step exploration.*file-by-file diffs/is);
  assert.match(skillSource, /add the `交付：` comment and move the issue to `in_review`/i);
});
