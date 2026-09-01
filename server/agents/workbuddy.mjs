import { ApiError } from "../database.mjs";
import { agentByKind } from "../../shared/agents.mjs";
import {
  CONFIGURE_WORKBUDDY_ACTION,
  CONNECT_WORKBUDDY_ACTION,
} from "../../shared/agent-runtime.mjs";
import { createWorkbuddyDesktopController } from "../workbuddy-desktop-controller.mjs";

const definition = agentByKind("workbuddy");

/**
 * WorkBuddy is a host-launch agent: the board can wake a session inside its
 * client but cannot run a turn itself, because WorkBuddy ships no CLI with a
 * streaming output mode. Call sites decide what is possible by reading
 * `capabilities`, never by testing the agent's name — the headless-only entry
 * points below exist so that a mistaken call fails with a readable error
 * instead of `undefined is not a function`.
 */
export function createWorkbuddyAgent(config = {}) {
  const {
    desktopController = createWorkbuddyDesktopController({
      preferredPort: config.debuggingPort,
    }),
    // 由 app.mjs 惰性传入：origin 要等 listen() 之后才知道。
    verifyBoardMcp = async () => ({ ok: true, detail: "" }),
  } = config;

  function headlessUnsupported(what) {
    return new ApiError(
      409,
      "AGENT_HEADLESS_UNSUPPORTED",
      `${definition.label} 无法由看板直接运行${what}，只能在它自己的客户端里唤起会话`,
    );
  }

  return {
    id: definition.kind,
    label: definition.label,
    actor: definition.actor,
    assigneeTarget: definition.assigneeTarget,
    capabilities: definition.capabilities,
    executable: null,
    desktopController,

    /** The client mints the conversation id, so it is only known after launch. */
    preassignsSessionId: false,

    async sessionExists(sessionId) {
      return Boolean(sessionId);
    },

    async status() {
      // MCP 与桌面控制是两条独立前置条件。先并发检查，才能把「MCP 已配、
      // 只是普通启动没开调试端口」和「MCP 本身没配好」准确地区分开。
      const [inspected, boardMcp] = await Promise.all([
        desktopController.inspect(),
        verifyBoardMcp().catch((error) => ({
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        })),
      ]);
      if (!boardMcp.ok) {
        return {
          status: "needs_setup",
          transports: [],
          reasonCode: "WORKBUDDY_AUTH_REQUIRED",
          statusMessage: `${definition.label} 还没有连上看板的 MCP：${boardMcp.detail}`,
          action: CONFIGURE_WORKBUDDY_ACTION,
        };
      }
      if (!inspected.available) {
        return {
          status: "needs_setup",
          transports: [],
          reasonCode: "WORKBUDDY_DESKTOP_UNAVAILABLE",
          statusMessage: `${definition.label} 的 MCP 已连接，但桌面客户端没有开启看板控制`
            + `${inspected.detail ? `（${inspected.detail}）` : ""}。`,
          action: CONNECT_WORKBUDDY_ACTION,
        };
      }
      return { status: "ready", transports: ["host-draft", "host-submit"] };
    },

    resolveWorkspace() {
      // WorkBuddy runs each conversation in its own sandbox directory, so the
      // board has no say in the working directory.
      throw headlessUnsupported("工作区");
    },

    catalog() {
      throw headlessUnsupported("模型与技能目录");
    },

    buildTurn() {
      throw headlessUnsupported("对话轮次");
    },

    createDecoder() {
      throw headlessUnsupported("事件流");
    },
  };
}
