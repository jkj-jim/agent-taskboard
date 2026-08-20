// 任务启动提示词的唯一生成处（document/design/desktop-app-packaging.md §10）。
//
// UI 不生成 Agent 最终提示词，控制器也不自己拼装：它们只提供
// `TaskInstructionInput`，正文只在这里成形。各 Agent 的差异体现为不同的
// renderer，而不是散落在调用点的字符串拼接。

import { ApiError } from "../database.mjs";
import { shellQuote } from "./taskctl-bin.mjs";

export const MAX_INSTRUCTION_LENGTH = 1_024;

function assertLength(instruction, code) {
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    throw new ApiError(
      409,
      code,
      `The task instruction exceeds ${MAX_INSTRUCTION_LENGTH} characters`,
    );
  }
  return instruction;
}

/**
 * Codex 原生 composer：skill mention 由宿主预填接口写入，这里只产出它后面的正文。
 * shim 在正文中只出现一次。
 */
export function renderCodexTaskInstruction({ identifier, taskctlShimPath }) {
  const shim = shellQuote(taskctlShimPath);
  return assertLength(
    `执行任务 ${identifier}。Taskboard CLI 为 ${shim}；`
    + `先用它运行 issue brief ${shellQuote(identifier)} --json，`
    + "本轮后续 Taskboard 操作也只使用该入口。",
    "CODEX_INSTRUCTION_TOO_LONG",
  );
}

/**
 * WorkBuddy 通过 MCP 读写看板，提示词里不得出现 `taskctl`：
 * 放任它自己找 CLI 会导致用错会话身份写看板。工具名不带看板地址，
 * 这也是这段文本能通过 WorkBuddy 内容校验的原因。
 */
export function renderWorkbuddyTaskInstruction({ identifier, mcpServerName = "taskboard" }) {
  // 客户端按 MCP 服务器名给工具加前缀，所以工具名必须从服务器名派生：
  // 写死 `taskboard_*` 会在服务器改名后让整段提示词指向不存在的工具。
  const tool = (name) => `${mcpServerName}_${name}`;
  return [
    `执行任务 ${identifier}。`,
    `只使用 ${mcpServerName} 的 MCP 工具操作看板：`,
    `${tool("get_task")}、${tool("add_comment")}、${tool("move_task")}。`,
    "不要查找、安装或运行任何命令行工具。",
    `先用 ${tool("get_task")} 读取 ${identifier} 的最新内容与全部评论，`,
    "按 manage-taskboard 技能中的流程规则完成工作，",
    `再用 ${tool("add_comment")} 写交付说明，`,
    `最后用 ${tool("move_task")} 把任务移至 in_review。`,
  ].join("");
}

/** Claude 通过 deep link 打开草稿时用的正文；它同样靠绝对 shim 访问看板。 */
export function renderClaudeTaskInstruction({ identifier, taskctlShimPath }) {
  const shim = taskctlShimPath ? shellQuote(taskctlShimPath) : null;
  return assertLength(
    `使用 manage-taskboard skill 执行任务 ${identifier}。`
    + (shim ? `本任务中的每一次 Taskboard 操作都使用 ${shim}。` : ""),
    "CLAUDE_INSTRUCTION_TOO_LONG",
  );
}
