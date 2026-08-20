import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { extractChangelogSection } from "../scripts/extract-changelog.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(projectRoot, "scripts", "extract-changelog.mjs");

const SAMPLE = [
  "# 更新日志",
  "",
  "说明性的开头，不属于任何版本。",
  "",
  "## 1.1.0",
  "",
  "- 新增了一件事",
  "- 修了另一件事",
  "",
  "## 1.0.0",
  "",
  "首个版本。",
  "",
  "## 0.9.0",
  "",
].join("\n");

test("a version section stops at the next heading, not at the end of the file", () => {
  assert.equal(
    extractChangelogSection(SAMPLE, "1.1.0"),
    "- 新增了一件事\n- 修了另一件事",
  );
  assert.equal(extractChangelogSection(SAMPLE, "1.0.0"), "首个版本。");
});

test("a missing or empty section is null, never an empty release note", () => {
  assert.equal(extractChangelogSection(SAMPLE, "2.0.0"), null);
  // 标题在但正文是空的，等于没写；不能因为标题存在就放过
  assert.equal(extractChangelogSection(SAMPLE, "0.9.0"), null);
  // 开头那段说明文字不属于任何版本，不能被当成某一版的正文
  assert.equal(extractChangelogSection(SAMPLE, "更新日志"), null);
});

test("the shipped CHANGELOG has a section for the version about to be released", async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const changelog = await readFile(path.join(projectRoot, "CHANGELOG.md"), "utf8");

  // 预发布版允许没有小节（workflow 会用 --allow-missing 兜住），正式版不允许：
  // 等到 tag 推上去才发现漏写，Release 已经带着 assets 建出来了。
  if (manifest.version.includes("-")) return;
  const section = extractChangelogSection(changelog, manifest.version);
  assert.ok(section, `CHANGELOG.md 缺少 "## ${manifest.version}" 小节`);
});

test("the extractor fails loudly for stable and stays quiet with --allow-missing", () => {
  assert.throws(
    () => execFileSync("node", [script, "--version", "99.0.0"], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    }),
    (error) => {
      assert.match(error.stderr.toString(), /没有 99\.0\.0 的小节/);
      return true;
    },
  );

  const quiet = execFileSync("node", [script, "--version", "99.0.0", "--allow-missing"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(quiet, "");
});

test("the release workflow builds its notes from the CHANGELOG, not a phantom file", async () => {
  const workflow = await readFile(
    path.join(projectRoot, ".github", "workflows", "macos-release.yml"),
    "utf8",
  );

  // 之前这里 cat 的是一个仓库里根本不存在的 CHANGELOG-latest.md，
  // 正式版发布会在建 Release 之前就挂掉。
  assert.doesNotMatch(workflow, /CHANGELOG-latest\.md/);
  assert.match(workflow, /extract-changelog\.mjs/);
  // 正式版分支不得带 --allow-missing
  const stableStep = workflow.slice(
    workflow.indexOf('if [ "${{ steps.channel.outputs.channel }}" = "stable" ]'),
  ).split("else")[0];
  assert.doesNotMatch(stableStep, /--allow-missing/);
  // 两个通道都必须用同一份说明文件，且它在建 Release 之前就已生成
  assert.ok(
    workflow.indexOf("抽取本版更新说明") < workflow.indexOf("发布 stable"),
    "notes must exist before the release is created",
  );
  for (const channel of ["发布 stable", "发布 beta"]) {
    const step = workflow.slice(workflow.indexOf(channel));
    assert.match(step.split("gh release create")[1] ?? "", /RELEASE-NOTES\.md/);
  }
});
