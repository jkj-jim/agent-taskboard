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

/**
 * 用例不能让「本机装没装 Codex 客户端、仓库里有没有注入器」决定结论：真机上两者
 * 都在，`/api/meta` 就会报 `nativeCodexTaskLaunch: true`，CI 上又是 false。
 * 默认存根固定成「拉不起来」；要验拉起路径的用例自己传 overrides。
 */
export function offlineCodexBridge(overrides = {}) {
  return {
    supported: () => ({ ok: false, reason: "测试环境不拉起 Codex 客户端" }),
    state: () => "down",
    lastError: () => null,
    ensure: async () => {
      throw new Error("测试环境不拉起 Codex 客户端");
    },
    stop: () => {},
    ...overrides,
  };
}
