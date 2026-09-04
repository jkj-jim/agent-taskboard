// Agent CLI 的查找路径（document/design/desktop-app-packaging.md §6）。
//
// Finder 启动的 App 只拿到 launchd 的默认 PATH——实测就是
// `/usr/bin:/bin:/usr/sbin:/sbin`，一个字都不多。而 `codex` 装在
// `/opt/homebrew/bin`、`claude` 装在 `~/.local/bin`，两个都不在里面，于是探测
// 直接 `spawn codex ENOENT`，状态区报「不可用」——本机明明装了。
//
// 终端里跑 `npm run dev` 不会暴露这个问题：那条路径继承的是用户 shell 的 PATH。
// 所以这是一个只在安装版上出现、且每台机器都会出现的问题。
//
// 这里不去读用户的 shell 配置（要在 GUI 进程里跑别人的 rc 文件，慢且不可控），
// 而是把几个众所周知的安装位置补进 PATH。用户自己的 PATH 仍然排在最前面，
// 补充项只在原本找不到时才起作用。

import os from "node:os";
import path from "node:path";

/**
 * 补充搜索目录，按优先级排列。覆盖 Homebrew（两种架构）、Claude Code 官方安装器
 * 落点、以及几个常见的全局包管理器 bin 目录。
 *
 * nvm 装的全局包不在其中：它的路径带 Node 版本号（`~/.nvm/versions/node/v22.x/bin`），
 * 猜哪个版本不如让用户显式指定，所以那种情况仍然要靠 `CODEX_EXECUTABLE` /
 * `CLAUDE_EXECUTABLE` 给绝对路径。
 */
export function agentToolDirectories(home = os.homedir(), execPath = process.execPath) {
  return [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".claude", "local"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".npm-global", "bin"),
    // 兜底的 `node`：安装版随包带了一个（sidecar 自己就跑在上面），而用户的 node
    // 常来自 nvm，路径带版本号，猜不出来。Agent 的 hook 和插件脚本用 `/bin/sh -c`
    // 起 `node ...`，找不到就每轮以 127 失败。放在最后，用户自己的 node 优先。
    path.dirname(execPath),
  ];
}

/** 用户 PATH 在前，补充目录在后；重复项去掉，避免 PATH 越接越长。 */
export function withAgentToolsOnPath(env = process.env, home = os.homedir(), execPath = process.execPath) {
  const existing = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const merged = [];
  for (const directory of [...existing, ...agentToolDirectories(home, execPath)]) {
    if (!merged.includes(directory)) merged.push(directory);
  }
  return { ...env, PATH: merged.join(path.delimiter) };
}
