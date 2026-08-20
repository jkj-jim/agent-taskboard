import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(projectRoot, relative), "utf8");

test("the automation entry leaves no visible Taskboard surface in Codex", async () => {
  const automation = await read("inject/codex-automation.user.js");
  const panel = await read("inject/codex-taskboard-panel.user.js");
  const core = await read("inject/codex-taskboard.user.js");

  assert.match(automation, /__CODEX_TASKBOARD_PANEL_ENABLED__ = false/);
  assert.match(panel, /__CODEX_TASKBOARD_PANEL_ENABLED__ = true/);

  // 默认必须是关的：入口没被加载时不能意外挂出面板。
  assert.match(core, /PANEL_ENABLED = window\.__CODEX_TASKBOARD_PANEL_ENABLED__ === true/);
  // 创建入口按钮与挂载 iframe 这两条路径都要被同一个开关挡住。
  for (const fn of ["function ensureEntry() {", "function mountActivePage() {"]) {
    const body = core.slice(core.indexOf(fn));
    assert.match(
      body.slice(0, 120),
      /if \(!PANEL_ENABLED\) return;/,
      `${fn} must be gated by the panel flag`,
    );
  }
});

test("the injector picks the entry instead of always loading the panel", async () => {
  const injector = await read("scripts/codex-injector.mjs");
  assert.match(injector, /codex-automation\.user\.js/);
  assert.match(injector, /codex-taskboard-panel\.user\.js/);
  assert.match(injector, /currentInjectionSource\(\{ panel = true \} = \{\}\)/);
});
