import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ensureSkillInstalled,
  inspectSkillInstallation,
} from "../server/agents/skill-install.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-skill-"));
  const templateDirectory = path.join(root, "template");
  await mkdir(path.join(templateDirectory, "references"), { recursive: true });
  await writeFile(path.join(templateDirectory, "SKILL.md"), "# 模板\n");
  await writeFile(path.join(templateDirectory, "references", "cli.md"), "# CLI\n");
  return {
    root,
    templateDirectory,
    skillDirectory: path.join(root, "agents", "skills", "manage-taskboard"),
    claudeHome: path.join(root, "claude-home"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const install = (f, overrides = {}) => ensureSkillInstalled({
  profile: "production",
  skillDirectory: f.skillDirectory,
  templateDirectory: f.templateDirectory,
  claudeHome: f.claudeHome,
  appVersion: "1.2.3",
  installedAt: "2026-08-19T00:00:00.000Z",
  ...overrides,
});

test("production installs the template and links Claude at it", async () => {
  const f = await fixture();
  try {
    const report = await install(f);

    assert.deepEqual(report.changes, ["installed-skill", "linked-claude"]);
    assert.equal(report.installed, true);
    assert.equal(report.claudeLink.state, "linked");
    assert.equal(
      await readFile(path.join(f.skillDirectory, "references", "cli.md"), "utf8"),
      "# CLI\n",
    );
    assert.deepEqual(report.marker, {
      name: "manage-taskboard",
      installedVersion: "1.2.3",
      installedAt: "2026-08-19T00:00:00.000Z",
    });
    // Claude 侧是软链，不是第二份拷贝
    assert.equal((await lstat(report.claudeLink.path)).isSymbolicLink(), true);
  } finally {
    await f.cleanup();
  }
});

test("a second run changes nothing and never overwrites user edits", async () => {
  const f = await fixture();
  try {
    await install(f);
    await writeFile(path.join(f.skillDirectory, "SKILL.md"), "# 我自己改过的\n");

    const report = await install(f);

    assert.deepEqual(report.changes, []);
    assert.equal(
      await readFile(path.join(f.skillDirectory, "SKILL.md"), "utf8"),
      "# 我自己改过的\n",
    );
  } finally {
    await f.cleanup();
  }
});

test("a Claude target pointing elsewhere is reported, never silently replaced", async () => {
  const f = await fixture();
  try {
    const foreign = path.join(f.root, "someone-elses-skill");
    await mkdir(foreign, { recursive: true });
    await mkdir(path.join(f.claudeHome, "skills"), { recursive: true });
    await symlink(foreign, path.join(f.claudeHome, "skills", "manage-taskboard"));

    const report = await install(f);

    assert.deepEqual(report.changes, ["installed-skill"], "the conflicting link is left alone");
    assert.equal(report.claudeLink.state, "conflict");
    assert.equal(report.claudeLink.target, foreign);
  } finally {
    await f.cleanup();
  }
});

test("beta never writes the shared skill, the link or the marker", async () => {
  const f = await fixture();
  try {
    const report = await install(f, { profile: "beta" });

    assert.equal(report.writable, false);
    assert.deepEqual(report.changes, []);
    assert.equal(report.installed, false);
    assert.equal(report.claudeLink.state, "missing");
    await assert.rejects(lstat(f.skillDirectory), /ENOENT/);
    await assert.rejects(lstat(path.join(f.claudeHome, "skills")), /ENOENT/);
  } finally {
    await f.cleanup();
  }
});

test("a link reached by a different path still counts as linked", async () => {
  const f = await fixture();
  try {
    await install(f);
    // 经由另一条等价路径指过来，解析后是同一个目录，不该被判成冲突
    await rm(path.join(f.claudeHome, "skills", "manage-taskboard"));
    await symlink(
      path.join(f.skillDirectory, ".", ""),
      path.join(f.claudeHome, "skills", "manage-taskboard"),
    );

    const report = await inspectSkillInstallation({
      skillDirectory: f.skillDirectory,
      claudeHome: f.claudeHome,
    });
    assert.equal(report.claudeLink.state, "linked");
  } finally {
    await f.cleanup();
  }
});

test("the shipped template is staged per app version without touching the shared skill", async () => {
  const f = await fixture();
  try {
    const profileDirectory = path.join(f.root, "profiles", "production");
    const first = await import("../server/agents/skill-install.mjs").then((m) => m.stageSkillTemplate({
      profileDirectory,
      templateDirectory: f.templateDirectory,
      appVersion: "1.2.3",
    }));
    assert.equal(first.staged, true);
    assert.equal(
      await readFile(path.join(first.path, "SKILL.md"), "utf8"),
      "# 模板\n",
    );

    // 同版本再来一次不重复写，用户在共享目录里的改动也与它无关
    const again = await import("../server/agents/skill-install.mjs").then((m) => m.stageSkillTemplate({
      profileDirectory,
      templateDirectory: f.templateDirectory,
      appVersion: "1.2.3",
    }));
    assert.equal(again.staged, false);
    await assert.rejects(lstat(f.skillDirectory), /ENOENT/, "staging must not install the skill");
  } finally {
    await f.cleanup();
  }
});

test("discovery is judged by the directory each agent actually scans", async () => {
  const f = await fixture();
  const { isSkillDiscoverable } = await import("../server/agents/skill-install.mjs");
  try {
    const claudeSkills = path.join(f.claudeHome, "skills");
    assert.equal(await isSkillDiscoverable({ skillsRoot: claudeSkills }), false);

    await install(f);
    assert.equal(await isSkillDiscoverable({ skillsRoot: claudeSkills }), true);

    // 目录在但没有 SKILL.md 不算能发现
    const bare = path.join(f.root, "bare", "skills", "manage-taskboard");
    await mkdir(bare, { recursive: true });
    assert.equal(await isSkillDiscoverable({ skillsRoot: path.dirname(bare) }), false);
  } finally {
    await f.cleanup();
  }
});

test("applying the template backs up the current skill and is production-only", async () => {
  const f = await fixture();
  const { applySkillTemplate } = await import("../server/agents/skill-install.mjs");
  try {
    await install(f);
    await writeFile(path.join(f.skillDirectory, "SKILL.md"), "# 我自己改过的\n");
    const profileDirectory = path.join(f.root, "profiles", "production");

    const applied = await applySkillTemplate({
      profile: "production",
      skillDirectory: f.skillDirectory,
      templateDirectory: f.templateDirectory,
      profileDirectory,
      appliedAt: "2026-08-19T01:02:03.000Z",
    });

    // 覆盖生效，但用户原内容仍可找回
    assert.equal(await readFile(path.join(f.skillDirectory, "SKILL.md"), "utf8"), "# 模板\n");
    assert.equal(
      await readFile(path.join(applied.backupPath, "SKILL.md"), "utf8"),
      "# 我自己改过的\n",
    );

    await assert.rejects(
      applySkillTemplate({
        profile: "beta",
        skillDirectory: f.skillDirectory,
        templateDirectory: f.templateDirectory,
        profileDirectory,
        appliedAt: "2026-08-19T01:02:04.000Z",
      }),
      /只有 production/,
    );
  } finally {
    await f.cleanup();
  }
});

test("applying the template refuses to write into a git working tree", async () => {
  const { applySkillTemplate, enclosingGitWorktree } = await import(
    "../server/agents/skill-install.mjs"
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-worktree-"));
  // 模拟开发机的布局：共享 skill 是一条指向仓库工作树的软链
  const repo = path.join(root, "repo");
  const repoSkill = path.join(repo, "skills", "manage-taskboard");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await mkdir(repoSkill, { recursive: true });
  await writeFile(path.join(repoSkill, "SKILL.md"), "用户改过的内容\n");

  const shared = path.join(root, "shared-skill");
  await symlink(repoSkill, shared);

  const template = path.join(root, "template");
  await mkdir(template, { recursive: true });
  await writeFile(path.join(template, "SKILL.md"), "模板内容\n");

  assert.equal(await enclosingGitWorktree(shared), await realpath(repo));

  await assert.rejects(
    () => applySkillTemplate({
      profile: "production",
      skillDirectory: shared,
      templateDirectory: template,
      profileDirectory: path.join(root, "profile"),
      appliedAt: "2026-08-20T00:00:00.000Z",
    }),
    (error) => {
      assert.equal(error.code, "SKILL_POINTS_AT_WORKTREE");
      return true;
    },
  );
  // 工作树里的内容必须原样保留
  assert.equal(await readFile(path.join(repoSkill, "SKILL.md"), "utf8"), "用户改过的内容\n");

  // 不在工作树里的共享目录照常可写
  const plain = path.join(root, "plain-skill");
  await mkdir(plain, { recursive: true });
  await writeFile(path.join(plain, "SKILL.md"), "旧内容\n");
  const applied = await applySkillTemplate({
    profile: "production",
    skillDirectory: plain,
    templateDirectory: template,
    profileDirectory: path.join(root, "profile"),
    appliedAt: "2026-08-20T00:00:00.000Z",
  });
  assert.ok(applied.backupPath);
  assert.equal(await readFile(path.join(plain, "SKILL.md"), "utf8"), "模板内容\n");

  await rm(root, { recursive: true, force: true });
});
