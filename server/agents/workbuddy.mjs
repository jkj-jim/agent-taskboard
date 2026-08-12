import { ApiError } from "../database.mjs";
import { agentByKind } from "../../shared/agents.mjs";
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
      return {
        available: inspected.available,
        authenticated: null,
        detail: inspected.detail,
      };
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
