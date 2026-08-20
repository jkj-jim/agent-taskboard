import path from "node:path";
import { renderWorkbuddyTaskInstruction } from "./agents/task-instruction.mjs";

import { ApiError } from "./database.mjs";
import { agentByKind } from "../shared/agents.mjs";
import {
  WORKBUDDY_SERVER_NAME,
  ensureWorkbuddyBoardAccess,
  readMcpRegistration,
} from "./workbuddy-host-setup.mjs";

const definition = agentByKind("workbuddy");

/**
 * Turns "this task is assigned to WorkBuddy" into a live session in the
 * WorkBuddy client, mirroring what `createCodexTaskLaunchCoordinator` does for
 * Codex. Two differences drive the separate implementation:
 *
 *   no taskctl     the board cannot influence the environment of the agent
 *                  process WorkBuddy spawns, so board access goes through MCP.
 *   no local URL   WorkBuddy's gateway rejects any turn whose content contains
 *                  `http://127.0.0.1:<port>`, so the instruction must not name
 *                  the board's address. The address lives in the MCP config.
 *
 * The workspace is not one of them. WorkBuddy's own name for a checkout is a
 * 工作空间, but it is the same plain directory path Codex and Claude take, so
 * the project resolves through the shared `deviceWorkspaces` map. Left unset,
 * the client opens each conversation in a throwaway `~/WorkBuddy/<timestamp>`
 * folder, where none of the project's own entry instructions are in reach.
 */
export function createWorkbuddyTaskLaunchCoordinator({
  desktopController,
  loadTask,
  bindSession,
  boardOrigin,
  skillPath,
  resolveWorkspace,
  ensureBoardAccess = ensureWorkbuddyBoardAccess,
  readRegistration = readMcpRegistration,
  // 提示词里的工具名由它派生；服务器改名时两处必须一起变。
  mcpServerName = WORKBUDDY_SERVER_NAME,
}) {
  let creationQueue = Promise.resolve();
  const launches = new Map();
  const unboundByTask = new Map();
  let accessPromise = null;

  /** Registration is idempotent, so one call per process is enough. */
  function ensureAccessOnce() {
    if (!accessPromise) {
      accessPromise = ensureBoardAccess({
        origin: typeof boardOrigin === "function" ? boardOrigin() : boardOrigin,
        description: "本地任务看板：列任务、读任务详情与评论、写评论回报进展、按版本改状态",
        skillPath,
      }).catch((error) => {
        accessPromise = null;
        throw error;
      });
    }
    return accessPromise;
  }

  function serializedCreate(input) {
    const created = creationQueue
      .catch(() => {})
      .then(() => desktopController.createTask(input));
    creationQueue = created;
    return created;
  }

  function instructionFor(task) {
    // 正文只在 Agent renderer 里成形（§10）。
    return renderWorkbuddyTaskInstruction({
      identifier: task.identifier,
      mcpServerName,
    });
  }

  async function run(input) {
    const task = await loadTask(input.taskId, input);
    if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${input.taskId}' does not exist`);
    if (task.version !== input.expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
        expectedVersion: input.expectedVersion,
        actualVersion: task.version,
      });
    }
    if (task.assignee?.type !== "agent" || task.assignee.id !== definition.actor.id) {
      throw new ApiError(
        409,
        "WORKBUDDY_NOT_ASSIGNED",
        `This task is not assigned to ${definition.label}`,
      );
    }
    if (input.trigger === "status-transition" && task.status !== "in_progress") {
      throw new ApiError(
        409,
        "INVALID_AGENT_LAUNCH_STATE",
        `${definition.label} auto-launch requires an in-progress task`,
      );
    }

    const access = await ensureAccessOnce();

    // A disabled server is simply absent from the agent's tools, and launching
    // then costs a full turn only to end in "I have no way to read the task".
    // Only the configuration is worth checking: the proxy connects lazily and
    // closes again, so a quiet socket proves nothing.
    const registration = await readRegistration();
    if (registration?.disabled) {
      throw new ApiError(
        409,
        "WORKBUDDY_BOARD_ACCESS_DISABLED",
        `${definition.label} 中的 taskboard MCP 服务处于停用状态，启动后它将无法读写任务。`
        + "请在「专家·技能·连接器 → 连接器 → MCP 服务管理」中启用它，然后重启 WorkBuddy。",
        { mcpUrl: access.mcp.url },
      );
    }

    // A project with no checkout on this device is not a reason to refuse the
    // launch: the conversation still runs, just in WorkBuddy's own directory.
    const workspacePath = (await resolveWorkspace?.(task, input)) ?? null;
    const create = {
      instruction: instructionFor(task),
      workspacePath,
      skillName: path.basename(skillPath),
    };

    if (input.trigger === "manual") {
      const prepared = await serializedCreate({ ...create, submit: false });
      if (prepared.status !== "prepared") {
        throw new Error(`${definition.label} manual task launch did not leave an editable prompt`);
      }
      return { status: "prepared", agentKind: definition.kind, task, access };
    }

    let pending = unboundByTask.get(task.id);
    if (pending && pending.previousSessionId !== input.previousSessionId) pending = null;
    if (!pending) {
      const created = await serializedCreate({ ...create, submit: true });
      if (created.status !== "started" || !created.sessionId) {
        throw new Error(`${definition.label} automatic task launch did not create a session`);
      }
      pending = { sessionId: created.sessionId, previousSessionId: input.previousSessionId };
      unboundByTask.set(task.id, pending);
    }

    const boundTask = await bindSession({
      taskId: task.id,
      agentKind: definition.kind,
      sessionId: pending.sessionId,
      previousSessionId: pending.previousSessionId,
    }, input);
    unboundByTask.delete(task.id);
    return {
      status: "started",
      agentKind: definition.kind,
      sessionId: pending.sessionId,
      task: boundTask,
      access,
    };
  }

  return {
    /** Reuses an in-flight launch so a double click cannot start two sessions. */
    launch(input) {
      if (input.trigger === "manual") return run(input);
      const key = `${input.taskId}:${input.expectedVersion}`;
      if (launches.has(key)) return launches.get(key);
      const launch = run(input).catch((error) => {
        launches.delete(key);
        throw error;
      });
      launches.set(key, launch);
      return launch;
    },
    /** Brings the session bound to a task back to the front of the client. */
    openSession(sessionId) {
      return desktopController.openSession(sessionId);
    },
  };
}
