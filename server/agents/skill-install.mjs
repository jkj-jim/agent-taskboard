// 默认 skill 的安装与发现（document/design/desktop-app-packaging.md §7）。
//
// 权威目录只有一个：~/.agents/skills/manage-taskboard。Claude Code 与 Codex 各自
// 只扫自己的 skills 目录，所以两边都建一条指向它的软链——Codex 的应用包里
// ~/.codex/skills 与 ~/.agents/skills 都出现过，赌它认共享目录不如多建一条。
// 实测（Codex 151.0.7922.174）它两个都扫：同一个 Skill 会在补全下拉里出现两次。
// 安装版的两条软链指向同一份 SKILL.md，所以重复项无害；注入器也已按路径逐个
// 试选，不再假设候选只有一个。
// skill 是三套实例的共享例外，写权限只给 production：beta 一律只读，连冲突都只报不改。

import { cp, lstat, mkdir, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const SKILL_NAME = "manage-taskboard";
const MARKER_FILE = ".taskboard-skill.json";

/**
 * 共享 skill 解析后的真实路径是否落在某个 git 工作树里。看 realpath 而不是原路径：
 * 开发机上这里通常是一条软链，只看原路径永远发现不了它指向仓库。
 */
export async function enclosingGitWorktree(skillDirectory) {
  let current;
  try {
    current = await realpath(skillDirectory);
  } catch {
    return null; // 还不存在，谈不上落在工作树里
  }
  while (true) {
    if ((await pathState(path.join(current, ".git"))).exists) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function pathState(target) {
  try {
    const link = await lstat(target);
    if (link.isSymbolicLink()) {
      return { exists: true, symlink: true, target: await readlink(target) };
    }
    return { exists: true, symlink: false, target: null };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, symlink: false, target: null };
    throw error;
  }
}

/** 同一个目录可能经由不同路径抵达，比较解析后的真实路径。 */
async function samePath(left, right) {
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return false;
  }
}

async function readMarker(skillDirectory) {
  try {
    return JSON.parse(await readFile(path.join(skillDirectory, MARKER_FILE), "utf8"));
  } catch {
    return null;
  }
}

async function describeLink(skillsRoot, skillDirectory) {
  const linkPath = path.join(skillsRoot, SKILL_NAME);
  const state = await pathState(linkPath);
  if (!state.exists) return { state: "missing", path: linkPath, target: null };
  if (await samePath(linkPath, skillDirectory)) {
    return { state: "linked", path: linkPath, target: state.target };
  }
  // 已经被别的东西占着：先展示冲突，绝不静默删除用户的目录或软链。
  return { state: "conflict", path: linkPath, target: state.target };
}

/**
 * 只读地看一眼现状。安装与否、软链是否正确，都由这里回答，
 * 写入路径和 UI 都用同一份判断。
 */
export async function inspectSkillInstallation({ skillDirectory, claudeHome, codexHome }) {
  const installedState = await pathState(skillDirectory);
  const installed = installedState.exists
    && await stat(path.join(skillDirectory, "SKILL.md")).then(() => true, () => false);

  return {
    skillDirectory,
    installed,
    isSymlink: installedState.symlink,
    marker: await readMarker(skillDirectory),
    claudeLink: await describeLink(path.join(claudeHome, "skills"), skillDirectory),
    // Codex 两个位置都扫（实测），多建一条软链是幂等的：两条指向同一份 SKILL.md，
    // 补全下拉里的重复项因此指向同一个路径。
    codexLink: codexHome
      ? await describeLink(path.join(codexHome, "skills"), skillDirectory)
      : null,
  };
}

/**
 * 把本次 App 携带的模板存到 profile App Data 的版本化目录，供差异查看使用。
 * 它写在 profile 自己的目录里，不碰共享 skill，所以 beta 也可以写自己的那份。
 */
export async function stageSkillTemplate({ profileDirectory, templateDirectory, appVersion }) {
  const target = path.join(profileDirectory, "skill-templates", appVersion);
  const existing = await pathState(target);
  if (existing.exists) return { path: target, staged: false };
  await mkdir(path.dirname(target), { recursive: true });
  await cp(templateDirectory, target, { recursive: true });
  return { path: target, staged: true };
}

/**
 * 「目录在」不等于「Agent 能发现」：Claude 扫 ~/.claude/skills，Codex 扫
 * ~/.codex/skills（也引用过 ~/.agents/skills）。这里按 Agent 各自真正扫描的位置判断（§7）。
 */
export async function isSkillDiscoverable({ skillsRoot }) {
  const entry = path.join(skillsRoot, SKILL_NAME, "SKILL.md");
  try {
    return (await stat(entry)).isFile();
  } catch {
    return false;
  }
}

async function listFiles(root, prefix = "") {
  let entries;
  try {
    const { readdir } = await import("node:fs/promises");
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return new Map();
  }
  const files = new Map();
  for (const entry of entries) {
    if (entry.name === MARKER_FILE) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [key, value] of await listFiles(full, relative)) files.set(key, value);
    } else {
      files.set(relative, await readFile(full, "utf8").catch(() => null));
    }
  }
  return files;
}

/**
 * 比较用户当前的共享 skill 与本版本携带的模板。只回差异清单，不动任何文件——
 * 是否应用由用户在 production 里显式决定，App 更新不静默覆盖（§7）。
 */
export async function diffSkillAgainstTemplate({ skillDirectory, templateDirectory }) {
  const [installed, template] = await Promise.all([
    listFiles(skillDirectory),
    listFiles(templateDirectory),
  ]);
  const files = [];
  for (const [name, contents] of template) {
    if (!installed.has(name)) files.push({ path: name, state: "added" });
    else if (installed.get(name) !== contents) files.push({ path: name, state: "changed" });
  }
  for (const name of installed.keys()) {
    if (!template.has(name)) files.push({ path: name, state: "only-installed" });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, identical: files.length === 0 };
}

/**
 * 手动把本版本模板应用到共享 skill。只有 production 能调；覆盖前先把当前内容
 * 备份到 profile 自己的目录，用户改过的东西不会因为一次点击就没了（§7）。
 */
export async function applySkillTemplate({
  profile,
  skillDirectory,
  templateDirectory,
  profileDirectory,
  appliedAt,
}) {
  if (profile !== "production") {
    throw new Error("只有 production 实例可以写入共享 skill");
  }
  // 开发机上共享 skill 往往是一条指向仓库工作树的软链（README「三套实例共存」）。
  // 那种情况下点一次「应用模板」会把模板逐文件写进被 git 跟踪的文件里，
  // 表现成一堆没人做过的本地改动。宁可拒绝，让开发者直接改仓库。
  const worktree = await enclosingGitWorktree(skillDirectory);
  if (worktree) {
    const error = new Error(
      `共享 skill 指向 git 工作树 ${worktree}，应用模板会改动被跟踪的文件；`
      + "开发机请直接在仓库里改 skill 并提交",
    );
    error.code = "SKILL_POINTS_AT_WORKTREE";
    throw error;
  }
  const backupPath = path.join(profileDirectory, "skill-backups", appliedAt.replace(/[:.]/g, "-"));
  const current = await pathState(skillDirectory);
  if (current.exists) {
    await mkdir(path.dirname(backupPath), { recursive: true });
    await cp(skillDirectory, backupPath, { recursive: true, dereference: true });
  }
  // 逐文件覆盖而不是先删后拷：共享目录可能是软链，删掉会把用户的链接一起弄丢。
  await cp(templateDirectory, skillDirectory, { recursive: true, dereference: true });
  return { backupPath: current.exists ? backupPath : null, appliedAt };
}

/**
 * production 负责安装与修复；beta 只读。返回的 `changes` 是这次真正做过的动作，
 * 空数组表示什么都没改——App 更新不会覆盖用户已经编辑过的内容。
 */
export async function ensureSkillInstalled({
  profile,
  skillDirectory,
  templateDirectory,
  claudeHome,
  codexHome,
  appVersion,
  installedAt,
}) {
  const before = await inspectSkillInstallation({ skillDirectory, claudeHome, codexHome });
  if (profile !== "production") {
    // beta 不得写共享 skill、软链或 .taskboard-skill.json（§7）。
    return { ...before, writable: false, changes: [] };
  }

  const changes = [];
  if (!before.installed) {
    await mkdir(path.dirname(skillDirectory), { recursive: true });
    await cp(templateDirectory, skillDirectory, { recursive: true });
    await writeFile(
      path.join(skillDirectory, MARKER_FILE),
      `${JSON.stringify({ name: SKILL_NAME, installedVersion: appVersion, installedAt }, null, 2)}\n`,
    );
    changes.push("installed-skill");
  }

  for (const [link, change] of [
    [before.claudeLink, "linked-claude"],
    [before.codexLink, "linked-codex"],
  ]) {
    if (link?.state !== "missing") continue;
    await mkdir(path.dirname(link.path), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(skillDirectory, link.path);
    changes.push(change);
  }

  return {
    ...(await inspectSkillInstallation({ skillDirectory, claudeHome, codexHome })),
    writable: true,
    changes,
  };
}
