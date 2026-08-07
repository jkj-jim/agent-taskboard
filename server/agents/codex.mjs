import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  buildCodexArgs,
  buildCodexPrompt,
  normalizeCodexEvent,
} from "../ai-chat-process.mjs";
import { discoverAiCatalog, resolveAiWorkspace } from "../ai-chat-catalog.mjs";
import { agentByKind } from "../../shared/agents.mjs";

const execFileAsync = promisify(execFile);

const definition = agentByKind("codex");

export function createCodexAgent(config) {
  const {
    executable = "codex",
    statePath,
    database,
    processEnv = process.env,
    skillPath,
  } = config;

  return {
    id: definition.kind,
    label: definition.label,
    actor: definition.actor,
    assigneeTarget: definition.assigneeTarget,
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

    async status() {
      try {
        await execFileAsync(executable, ["--version"], {
          env: processEnv,
          encoding: "utf8",
          timeout: 10_000,
        });
        return { available: true, authenticated: null, detail: "" };
      } catch (error) {
        return {
          available: false,
          authenticated: false,
          detail: `无法运行 ${executable}：${error instanceof Error ? error.message : String(error)}`,
        };
      }
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
