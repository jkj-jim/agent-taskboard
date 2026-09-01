import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildCodexArgs,
  buildCodexPrompt,
  normalizeCodexEvent,
} from "../ai-chat-process.mjs";
import { discoverAiCatalog, resolveAiWorkspace } from "../ai-chat-catalog.mjs";
import { agentByKind } from "../../shared/agents.mjs";


const execFileAsync = promisify(execFile);

/** 凭据只来自 CODEX_HOME，不在 Electron 的 user-data-dir 里（任务 67 实测）。 */
async function hasCodexCredentials(codexHome) {
  try {
    const auth = JSON.parse(await readFile(path.join(codexHome, "auth.json"), "utf8"));
    return Boolean(auth?.tokens?.access_token || auth?.OPENAI_API_KEY);
  } catch {
    return false;
  }
}

const definition = agentByKind("codex");

/** 看板能自己拉起时给的是「现在就接上」，用户不必等到派发任务才触发。 */
const CONNECT_CODEX_DESKTOP_ACTION = {
  kind: "app-action",
  label: "连接客户端",
  message: "拉起 Codex 客户端并装上看板注入器。Codex 没在运行时用它自己的用户目录启动，"
    + "就是你平时那个 Codex；已经在运行时会另开一个隔离实例，原窗口不受影响。",
  autoRunnable: true,
  actionId: "connect-codex-desktop",
};

/** 看板拉不起来时才落到这条：告诉用户在仓库里怎么手动接上。终端命令只复制不代跑。 */
const COPY_CONNECT_COMMAND_ACTION = {
  kind: "terminal-command",
  label: "复制接入命令",
  command: "npm run codex",
  message: "在 Taskboard 仓库里运行它：会另开一个带调试端口的 Codex 实例并装上看板注入器，"
    + "现有 Codex 窗口不受影响。看板不会代你执行终端命令。",
  autoRunnable: false,
};

export function createCodexAgent(config) {
  const {
    executable = "codex",
    statePath,
    database,
    processEnv = process.env,
    skillPath,
    codexHome = processEnv.CODEX_HOME || path.join(os.homedir(), ".codex"),
    // 由 app.mjs 惰性传入：controller 与 bridge 都在 registry 之后才建好。
    inspectDesktop = async () => ({ available: false }),
    desktopBridge = () => null,
  } = config;

  const NATIVE_TRANSPORTS = ["native-draft", "native-submit", "headless"];

  return {
    id: definition.kind,
    label: definition.label,
    actor: definition.actor,
    assigneeTarget: definition.assigneeTarget,
    capabilities: definition.capabilities,
    executable,
    /** Codex mints the session id itself and reports it via `thread.started`. */
    preassignsSessionId: false,

    /** A Codex thread id only ever exists once the session has started. */
    async sessionExists(sessionId) {
      return Boolean(sessionId);
    },

    resolveWorkspace(projectId) {
      return resolveAiWorkspace(projectId, statePath, database);
    },

    /**
     * Codex 的登录态保存在全局 `CODEX_HOME/auth.json`，与 Electron profile 无关
     * （任务 67 的实测结论，见 §9）。所以先看 CLI 在不在，再看凭据在不在。
     */
    async status() {
      let version;
      try {
        const { stdout } = await execFileAsync(executable, ["--version"], {
          env: processEnv,
          encoding: "utf8",
          timeout: 10_000,
        });
        version = stdout.trim().split(/\s+/).at(-1);
      } catch (error) {
        return {
          status: "unavailable",
          transports: [],
          reasonCode: "AGENT_NOT_INSTALLED",
          statusMessage: `无法运行 ${executable}：${error instanceof Error ? error.message : String(error)}`,
        };
      }

      if (!(await hasCodexCredentials(codexHome))) {
        return {
          status: "needs_auth",
          transports: [],
          version,
          reasonCode: "CODEX_AUTH_REQUIRED",
          statusMessage: "Codex 尚未登录，看板无法用它创建会话。",
          action: {
            kind: "app-action",
            label: "登录 Codex",
            message: "打开一个隔离的 Codex 窗口完成登录；登录完成后回到这里即可分配任务。",
            autoRunnable: true,
            actionId: "open-codex-login",
          },
        };
      }

      // 状态灯代表的是「看板能不能把任务交给这个平台」，不是「本机装没装」。
      // Codex 的任务启动只有 native 一条路——`launch.mjs` 的 transport 偏好里
      // 没有 headless 兜底，一期验收要求 session 必须出现在 Codex 侧栏。
      const desktop = await inspectDesktop().catch((error) => ({
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      }));
      if (desktop?.available) {
        return { status: "ready", transports: NATIVE_TRANSPORTS, version };
      }

      // 客户端此刻没接上，但看板能自己把它拉起来（`prepareLaunch` 在派发前会做，
      // 状态区的按钮也能手动触发），所以这仍然算「可用」——判据是「交得出去」，
      // 不是「此刻连着」。报 needs_setup 反而会把 Codex 从负责人下拉里拿掉，
      // 让人连那个本该触发自动拉起的任务都建不出来。
      const bridge = desktopBridge();
      const launchable = bridge?.supported() ?? { ok: false, reason: null };
      if (launchable.ok) {
        const failure = bridge.lastError();
        return {
          status: "ready",
          transports: NATIVE_TRANSPORTS,
          version,
          statusMessage: bridge.state() === "starting"
            ? `正在拉起 ${definition.label} 客户端。`
            : `${definition.label} 客户端还没接上，派发任务时会自动拉起`
              + `${failure ? `（上次失败：${failure.message}）` : ""}。`,
          action: CONNECT_CODEX_DESKTOP_ACTION,
        };
      }
      return {
        status: "needs_setup",
        transports: [],
        version,
        reasonCode: "CODEX_DESKTOP_UNAVAILABLE",
        statusMessage: `${definition.label} CLI 已登录，但看板连不上它的客户端`
          + `${desktop?.reason ? `：${desktop.reason}` : ""}`
          + `${launchable.reason ? `，也无法自行拉起：${launchable.reason}` : ""}。`,
        action: COPY_CONNECT_COMMAND_ACTION,
      };
    },

    /**
     * 派发前把桥接拉起来。返回 null 表示不用等；返回 `ready` 时调用方先接受这次
     * 请求，等它落地后再补派发——冷启动要二三十秒，不能把拖拽卡在那里。
     */
    async prepareLaunch() {
      const bridge = desktopBridge();
      if (!bridge?.supported().ok) return null;
      const desktop = await inspectDesktop().catch(() => ({ available: false }));
      if (desktop?.available) return null;
      return {
        message: `正在拉起 ${definition.label} 客户端，就绪后自动开始。`,
        ready: bridge.ensure(),
      };
    },

    catalog(projectId) {
      return discoverAiCatalog({
        codexExecutable: executable,
        codexStatePath: statePath,
        database,
        projectId,
        processEnv,
      });
    },

    buildTurn({ thread, addDirectories, imagePaths, message, skills, attachmentPaths }) {
      return {
        args: buildCodexArgs(thread, addDirectories, imagePaths),
        cwd: undefined, // Codex takes its working directory through `-C`.
        prompt: buildCodexPrompt(
          thread,
          { message, skills, attachmentPaths },
          skillPath,
        ),
      };
    },

    createDecoder() {
      return (raw) => {
        const normalized = normalizeCodexEvent(raw);
        return normalized ? [normalized] : [];
      };
    },
  };
}
