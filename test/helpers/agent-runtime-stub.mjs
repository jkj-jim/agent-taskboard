import { AGENT_KINDS } from "../../shared/agents.mjs";

/**
 * 大多数用例关心的是任务、会话与启动，不是 Agent 装没装。
 * 让它们注入这个存根，把「负责人可分配」固定成 ready；真实探测、缓存、
 * stale / unknown 语义由 test/agent-runtime.test.mjs 单独覆盖。
 */
export function readyAgentRuntimeStatuses(overrides = {}) {
  const READY_TRANSPORTS = {
    codex: ["native-draft", "native-submit", "headless"],
    claude: ["headless"],
    workbuddy: ["host-draft", "host-submit"],
  };

  const statusFor = (kind) => ({
    kind,
    status: "ready",
    transports: READY_TRANSPORTS[kind] ?? ["headless"],
    checkedAt: new Date(0).toISOString(),
    stale: false,
    ...(overrides[kind] ?? {}),
  });

  return {
    get: async (kind) => statusFor(kind),
    list: async () => AGENT_KINDS.map(statusFor),
    forInteraction: async (kind) => statusFor(kind),
    hasFresh: () => true,
  };
}
