import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_INSTRUCTION_LENGTH,
  renderCodexTaskInstruction,
  renderWorkbuddyTaskInstruction,
} from "../server/agents/task-instruction.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the Codex instruction names the shim exactly once and stays under the limit", () => {
  const instruction = renderCodexTaskInstruction({
    identifier: "TEST-1",
    taskctlShimPath: "/tmp/board/bin/taskctl",
  });

  assert.match(instruction, /^执行任务 TEST-1。/);
  assert.equal(instruction.split("'/tmp/board/bin/taskctl'").length - 1, 1);
  assert.match(instruction, /issue brief 'TEST-1' --json/);
  assert.ok(instruction.length <= MAX_INSTRUCTION_LENGTH);
});

test("an over-long instruction is rejected rather than truncated", () => {
  assert.throws(
    () => renderCodexTaskInstruction({
      identifier: "TEST-1",
      taskctlShimPath: `/tmp/${"x".repeat(1_100)}/taskctl`,
    }),
    /exceeds 1024 characters/,
  );
});

test("the WorkBuddy instruction never mentions taskctl", () => {
  const instruction = renderWorkbuddyTaskInstruction({ identifier: "TEST-2" });
  assert.doesNotMatch(instruction, /taskctl/);
  assert.match(instruction, /taskboard_get_task/);
  assert.match(instruction, /in_review/);
});

// §10：除 renderer 外不得再有任务启动提示词正文，前端也不例外。
test("no launch instruction body survives outside the renderers", async () => {
  const files = [
    "server/codex-desktop-controller.mjs",
    "server/workbuddy-task-launch.mjs",
    "shared/taskboard-automation.mjs",
    "web/src/App.tsx",
  ];
  for (const file of files) {
    const source = await readFile(path.join(projectRoot, file), "utf8");
    assert.doesNotMatch(source, /`执行任务 \$\{/, `${file} still assembles an instruction body`);
    assert.doesNotMatch(source, /taskboard_get_task、/, `${file} still assembles an instruction body`);
    assert.doesNotMatch(
      source,
      /使用 manage-taskboard skill 执行任务/,
      `${file} still assembles an instruction body`,
    );
  }
});
