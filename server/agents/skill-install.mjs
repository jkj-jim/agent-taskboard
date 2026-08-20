// 默认 skill 的安装与发现（document/design/desktop-app-packaging.md §7）。
//
// 权威目录只有一个：~/.agents/skills/manage-taskboard。Codex 与 WorkBuddy 用它们
// 自己的默认发现机制，只有 Claude Code 需要一条软链。skill 是三套实例的共享例外，
// 所以写权限只给 production：beta 一律只读，连冲突都只报不改。

import { cp, lstat, mkdir, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const SKILL_NAME = "manage-taskboard";
const MARKER_FILE = ".taskboard-skill.json";

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

/**
 * 只读地看一眼现状。安装与否、软链是否正确，都由这里回答，
 * 写入路径和 UI 都用同一份判断。
 */
export async function inspectSkillInstallation({ skillDirectory, claudeHome }) {
  const installedState = await pathState(skillDirectory);
  const installed = installedState.exists
    && await stat(path.join(skillDirectory, "SKILL.md")).then(() => true, () => false);

  const claudeLinkPath = path.join(claudeHome, "skills", SKILL_NAME);
  const claudeState = await pathState(claudeLinkPath);
  let claudeLink;
  if (!claudeState.exists) {
    claudeLink = { state: "missing", path: claudeLinkPath, target: null };
  } else if (await samePath(claudeLinkPath, skillDirectory)) {
    claudeLink = { state: "linked", path: claudeLinkPath, target: claudeState.target };
  } else {
    // 已经被别的东西占着：先展示冲突，绝不静默删除用户的目录或软链。
    claudeLink = { state: "conflict", path: claudeLinkPath, target: claudeState.target };
  }

  return {
    skillDirectory,
    installed,
    isSymlink: installedState.symlink,
    marker: await readMarker(skillDirectory),
    claudeLink,
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
 * 「目录在」不等于「Agent 能发现」：Claude 走 ~/.claude/skills，Codex 与 WorkBuddy
 * 走 ~/.agents/skills。这里按 Agent 各自真正扫描的位置判断（§7）。
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
  appVersion,
  installedAt,
}) {
  const before = await inspectSkillInstallation({ skillDirectory, claudeHome });
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

  if (before.claudeLink.state === "missing") {
    await mkdir(path.dirname(before.claudeLink.path), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(skillDirectory, before.claudeLink.path);
    changes.push("linked-claude");
  }

  return {
    ...(await inspectSkillInstallation({ skillDirectory, claudeHome })),
    writable: true,
    changes,
  };
}
