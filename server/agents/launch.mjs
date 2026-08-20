// Agent 启动协调器（document/design/desktop-app-packaging.md §8）。
//
// 启动所有权只在服务端：一次业务请求写完任务后，这里统一选 transport。
// 先按任务已指定的负责人确定 Agent，再在该 Agent 内选 transport——
// 跨 transport 降级可以，跨 Agent 降级绝对不行。

/** 每个 Agent 在两种触发下的 transport 偏好，靠前的优先。 */
const TRANSPORT_PREFERENCE = {
  // Codex 的任务启动没有 headless 兜底：一期验收要求 session 出现在 Codex
  // 对应项目侧栏，automation 不可用时如实返回 failed（§8、§9）。
  codex: {
    manual: ["native-draft"],
    "status-transition": ["native-submit"],
  },
  claude: {
    manual: ["headless"],
    "status-transition": ["headless"],
  },
  workbuddy: {
    manual: ["host-draft"],
    "status-transition": ["host-submit"],
  },
};

const NATIVE_TRANSPORTS = new Set(["native-draft", "native-submit"]);
const HOST_TRANSPORTS = new Set(["host-draft", "host-submit"]);

export function selectTransport({ agentKind, trigger, available, preferred }) {
  const preference = TRANSPORT_PREFERENCE[agentKind]?.[trigger] ?? [];
  if (preferred) {
    // preferredTransport 必须属于该 Agent，且在它最近一次状态里真的可用。
    if (!preference.includes(preferred) || !available.includes(preferred)) {
      return { error: "UNSUPPORTED_TRANSPORT", transport: null };
    }
    return { error: null, transport: preferred };
  }
  const transport = preference.find((candidate) => available.includes(candidate));
  return transport
    ? { error: null, transport }
    : { error: "NO_SUPPORTED_TRANSPORT", transport: null };
}

export function createAgentLaunchCoordinator({
  registry,
  runtimeStatuses,
  runHeadless,
  runNative,
  runHost,
}) {
  // 并发合并：同一任务、版本和触发来源在同一时刻只跑一次，防止一次状态变化
  // 因为重复请求同时起两个 session。跨请求的持久去重由各 launcher 依据
  // `task_agent_sessions` 负责，那是 session 绑定的唯一权威。
  // 手动入口只预填 composer、不绑定 session，重复点击是正常交互，不参与合并。
  const inFlight = new Map();

  function idempotencyKey({ taskId, expectedVersion, trigger }) {
    if (trigger !== "status-transition") return null;
    return `${taskId}:${expectedVersion}:${trigger}`;
  }

  function failure(agentKind, transport, reasonCode, message, setupAction) {
    return {
      status: "failed",
      agentKind,
      ...(transport ? { transport } : {}),
      ...(reasonCode ? { reasonCode } : {}),
      ...(setupAction ? { setupAction } : {}),
      error: message.slice(0, 2_000),
    };
  }

  async function run(request) {
    const {
      task,
      expectedVersion,
      trigger,
      presentation,
      preferredTransport,
      previousSessionId,
      sourceRequest,
      cloud,
    } = request;
    const agent = registry.list().find((candidate) => candidate.actor.id === task.assignee.id);
    if (!agent) return null;

    const runtime = await runtimeStatuses.forInteraction(agent.id);
    if (runtime.status !== "ready" && !runtime.stale && runtime.status !== "unknown") {
      // 该 Agent 起不来就如实返回它自己的恢复动作，不改用别的 Agent。
      return failure(
        agent.id,
        null,
        runtime.reasonCode ?? "AGENT_NOT_READY",
        runtime.statusMessage ?? `${agent.label} 当前不可用`,
        runtime.action,
      );
    }

    const selection = selectTransport({
      agentKind: agent.id,
      trigger,
      available: runtime.transports,
      preferred: preferredTransport,
    });
    if (selection.error) {
      return failure(
        agent.id,
        preferredTransport ?? null,
        selection.error === "UNSUPPORTED_TRANSPORT" ? undefined : runtime.reasonCode,
        selection.error === "UNSUPPORTED_TRANSPORT"
          ? `${agent.label} 不支持 ${preferredTransport}`
          : `${agent.label} 当前没有可用的启动方式`,
        runtime.action,
      );
    }

    const transport = selection.transport;
    try {
      if (NATIVE_TRANSPORTS.has(transport)) {
        const launched = await runNative({
          task,
          expectedVersion,
          trigger,
          presentation,
          previousSessionId,
          transport,
          sourceRequest,
          cloud,
        });
        return { ...launched, agentKind: agent.id, transport };
      }
      if (HOST_TRANSPORTS.has(transport)) {
        const launched = await runHost({
          agentKind: agent.id,
          task,
          expectedVersion,
          trigger,
          presentation,
          previousSessionId,
          sourceRequest,
        });
        return {
          status: launched.status,
          agentKind: agent.id,
          transport,
          sessionId: launched.sessionId ?? null,
        };
      }
      const launched = await runHeadless({ agentKind: agent.id, task });
      return { ...launched, agentKind: agent.id, transport };
    } catch (error) {
      // transport 失败不回滚任务数据，只把可执行的恢复动作带回去。
      const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
      return failure(agent.id, transport, runtime.reasonCode, message, runtime.action);
    }
  }

  return {
    async launch(request) {
      const key = idempotencyKey(request);
      if (!key) return run(request);
      const existing = inFlight.get(key);
      if (existing) return existing;

      const pending = run(request).finally(() => {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      });
      inFlight.set(key, pending);
      return pending;
    },
    selectTransport,
  };
}
