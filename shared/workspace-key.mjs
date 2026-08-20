// 工作目录的规范化键（document/design/desktop-app-packaging.md §9、§12）。
//
// 同一个目录可以由多条不同写法的路径指向：末尾斜杠、`.` 片段、大小写不同
// （APFS 默认大小写不敏感）、以及 macOS 文件名的 NFD 分解形式——中文和带音标的
// 目录名从 Finder 与从终端拿到的字节序列就不一样。直接比较原始字符串会把同一个
// 目录判成两个，于是同一份工作区在 Codex 侧被建成两个项目。

import path from "node:path";

/**
 * 规范化仅用于**比较与索引**，不用于展示或传给 Agent：
 * 那些地方要保留用户看到的原始路径。
 */
export function workspaceKey(workspacePath, { platform = process.platform } = {}) {
  if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) {
    throw new Error("workspaceKey needs a non-empty path");
  }
  // NFC 先行：macOS 会把路径以 NFD 交给部分接口，不统一就比不上。
  const resolved = path.resolve(workspacePath.normalize("NFC"));
  const withoutTrailingSlash = resolved.length > 1 && resolved.endsWith(path.sep)
    ? resolved.slice(0, -1)
    : resolved;
  // macOS 与 Windows 的文件系统默认大小写不敏感，Linux 敏感。
  return platform === "linux" ? withoutTrailingSlash : withoutTrailingSlash.toLowerCase();
}

export function sameWorkspace(left, right, options) {
  return workspaceKey(left, options) === workspaceKey(right, options);
}
