import { ApiError } from "../database.mjs";
import { agentByKind } from "../../shared/agents.mjs";
import { CONFIGURE_WORKBUDDY_ACTION } from "../../shared/agent-runtime.mjs";
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
      const inspected = await desktopController.inspect();
      if (!inspected.available) {
        // 装没装、能不能连，controller 只回一个 available；无法再细分时按
        // needs_setup 呈现并给出下载页，不谎称已确认未安装。
        return {
          status: "needs_setup",
          transports: [],
          reasonCode: "AGENT_NOT_INSTALLED",
          statusMessage: `${definition.label} 未在运行，或没有开启看板需要的调试端口`
            + `${inspected.detail ? `（${inspected.detail}）` : ""}。`,
          // 不引导下载：装没装由用户自己管；这里给的是「点一下就配好」的入口（§11）。
          action: CONFIGURE_WORKBUDDY_ACTION,
        };
      }
      // §11 的验收要求是「MCP 握手并确认 Taskboard tools 可列出」才算 ready，
      // 只看客户端在不在会把「连不上看板」误报成可用。
      const handshake = await verifyBoardMcp().catch((error) => ({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      }));
      if (!handshake.ok) {
        return {
          status: "needs_setup",
          transports: [],
          reasonCode: "WORKBUDDY_AUTH_REQUIRED",
          statusMessage: `${definition.label} 还没有连上看板的 MCP：${handshake.detail}`,
          action: {
            kind: "app-action",
            label: "去 WorkBuddy 授权",
            message: "打开 WorkBuddy 的 MCP 服务管理，允许看板这一项后回到这里重新检测。",
            autoRunnable: true,
            actionId: "configure-workbuddy",
          },
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
