// 让看板自己把 Codex 的自动化桥接拉起来（document/design/desktop-app-packaging.md §3、§9）。
//
// 桥接 = 一个开着调试端口的 Codex 客户端 + 里面挂着的看板注入器 + 一条常驻的
// CDP 连接（注入器每 2 秒写一次心跳，`CAPABILITY_EXPRESSION` 只认 8 秒内的）。
// 所以这里不是「注入一次就完事」，而是要养着一个子进程。
//
// 子进程用的就是开发命令那一份 `scripts/codex-injector.mjs`：注入逻辑只有一份，
// 安装版靠 `--automation-only`（不挂可见面板）、`--shared-profile`（Codex 没在跑时
// 借它自己的用户目录）和 `--no-supervisor`（服务归 sidecar 管）来收窄行为。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { ENV_PREFIX } from "../shared/taskboard-env.mjs";

export const DEFAULT_CODEX_APP_PATH = "/Applications/ChatGPT.app";
/** 开发命令用 9231，安装版沿用同一个端口，两边不会同时持有桥接。 */
export const DEFAULT_BRIDGE_PORT = 9231;
/** 冷启动要等 Codex 起来、renderer 稳定、注入完成，实测三十秒上下。 */
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 1_000;
const STDERR_TAIL_LIMIT = 2_000;

export function createCodexBridge({
  controller,
  injectorPath = null,
  launcherStatePath,
  // 端口要等 listen() 之后才知道，所以惰性求值。
  taskboardPort = () => null,
  port = DEFAULT_BRIDGE_PORT,
  appPath = DEFAULT_CODEX_APP_PATH,
  nodePath = process.execPath,
  processEnv = process.env,
  readyTimeoutMs = READY_TIMEOUT_MS,
  pollIntervalMs = READY_POLL_MS,
} = {}) {
  let child = null;
  let pending = null;
  let lastError = null;
  let stderrTail = "";

  /**
   * 能不能由看板拉起来。缺注入器是打包问题（资源没进 bundle），缺 ChatGPT.app
   * 是用户没装 Codex 客户端——两者都不该说成「Codex 不可用」。
   */
  function supported() {
    if (!injectorPath || !existsSync(injectorPath)) {
      return { ok: false, reason: "这份看板没有随包携带 Codex 注入器" };
    }
    if (!existsSync(appPath)) {
      return { ok: false, reason: `${appPath} 不在，Codex 客户端没有安装` };
    }
    return { ok: true, reason: null };
  }

  function running() {
    return Boolean(child && child.exitCode === null && !child.killed);
  }

  async function connected() {
    return await controller.inspect().then((state) => state.available === true, () => false);
  }

  function start() {
    stderrTail = "";
    const started = spawn(nodePath, [
      injectorPath,
      "--launch",
      "--watch",
      "--automation-only",
      "--shared-profile",
      "--no-supervisor",
      "--port",
      String(port),
    ], {
      env: {
        ...processEnv,
        [`${ENV_PREFIX}PORT`]: String(taskboardPort()),
        // 注入器自己的可写状态（隔离实例的 Electron 目录）不能落在只读的 app bundle 里。
        ...(launcherStatePath ? { [`${ENV_PREFIX}CODEX_LAUNCHER_DIR`]: launcherStatePath } : {}),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    started.stderr.setEncoding("utf8");
    started.stderr.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
    });
    started.once("exit", () => {
      if (child === started) child = null;
    });
    started.once("error", (error) => {
      lastError = error;
      if (child === started) child = null;
    });
    child = started;
    return started;
  }

  async function bringUp() {
    const capability = supported();
    if (!capability.ok) throw new Error(capability.reason);
    // 已经有别人（开发命令，或上一次拉起）挂着桥接就直接复用，不再多开一个。
    if (await connected()) return { status: "up", launched: false };

    const launched = running() ? child : start();
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      if (await connected()) return { status: "up", launched: true };
      if (launched.exitCode !== null || launched.killed) {
        throw new Error(`Codex 注入器退出了${stderrTail.trim() ? `：${stderrTail.trim().split("\n").at(-1)}` : ""}`);
      }
    }
    throw new Error(`等待 Codex 桥接就绪超时（${Math.round(readyTimeoutMs / 1000)} 秒）`);
  }

  return {
    supported,
    /** 桥接现在处于哪一步。`starting` 是「正在拉起」，不是失败。 */
    state() {
      if (pending) return "starting";
      if (running()) return "starting";
      return "down";
    },
    lastError: () => lastError,
    /**
     * 幂等：并发调用共用同一次拉起。已经接上时立刻返回，调用方因此可以无脑先问一次。
     */
    ensure() {
      if (pending) return pending;
      pending = bringUp()
        .then((result) => {
          lastError = null;
          return result;
        })
        .catch((error) => {
          lastError = error;
          throw error;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    /**
     * 看板退出时收掉自己养的子进程。注入器的 SIGTERM 处理只关闭它「自己启动的」
     * 隔离实例；借用户目录拉起来的那个 Codex 会留下，因为那是用户的窗口。
     */
    stop() {
      if (running()) child.kill("SIGTERM");
      child = null;
    },
  };
}
