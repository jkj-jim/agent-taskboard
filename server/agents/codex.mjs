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

export function createCodexAgent(config) {
  const {
    executable = "codex",
    statePath,
    database,
    processEnv = process.env,
    skillPath,
    codexHome = processEnv.CODEX_HOME || path.join(os.homedir(), ".codex"),
    // 由 app.mjs 惰性传入：controller 在 registry 之后才建好。
    inspectDesktop = async () => ({ available: false }),
  } = config;

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

      // native transport 需要可调试的 Codex 实例；探测不到时只留 headless，
      // 任务启动会因此如实失败，而不是悄悄换成别的方式。
      const desktop = await inspectDesktop().catch(() => ({ available: false }));
      const transports = desktop?.available
        ? ["native-draft", "native-submit", "headless"]
        : ["headless"];
      return { status: "ready", transports, version };
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
