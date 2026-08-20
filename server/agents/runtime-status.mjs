// 按 Agent 的 runtime 状态缓存与并发合并（document/design/desktop-app-packaging.md §6）。
//
// 两条语义必须分清：
//   stale   —— 有上次结果但这次没测出来，沿用旧状态并标记；
//   unknown —— 连上次结果都没有，明确表示「这次得不出结论」，不能伪装成 unavailable。

import {
  assertAgentRuntimeStatus,
  unknownRuntimeStatus,
} from "../../shared/agent-runtime.mjs";

export const RUNTIME_STATUS_TTL_MS = 10_000;
/** 交互路径（保存任务、移入进行中）最多等这么久，超时就用旧状态放行。 */
export const INTERACTIVE_WAIT_MS = 1_500;

export function createAgentRuntimeStatuses({
  registry,
  ttlMs = RUNTIME_STATUS_TTL_MS,
  now = () => Date.now(),
}) {
  const cache = new Map();
  const inFlight = new Map();

  async function probe(agent) {
    const startedAt = now();
    try {
      const runtime = assertAgentRuntimeStatus(await agent.status());
      return {
        kind: agent.id,
        ...runtime,
        checkedAt: new Date(startedAt).toISOString(),
        stale: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: agent.id,
        ...unknownRuntimeStatus(`检测 ${agent.label} 时出错：${message}`),
        checkedAt: new Date(startedAt).toISOString(),
        stale: false,
      };
    }
  }

  /** 同一 Agent 的并发探测合并成一次，避免首页刷新时打三份进程。 */
  function refresh(agent) {
    const existing = inFlight.get(agent.id);
    if (existing) return existing;
    const pending = probe(agent)
      .then((result) => {
        cache.set(agent.id, { result, at: now() });
        return result;
      })
      .finally(() => {
        if (inFlight.get(agent.id) === pending) inFlight.delete(agent.id);
      });
    inFlight.set(agent.id, pending);
    return pending;
  }

  function cached(agentKind) {
    const entry = cache.get(agentKind);
    if (!entry) return null;
    return { ...entry.result, fresh: now() - entry.at < ttlMs };
  }

  async function get(agentKind, { force = false, maxWaitMs = null } = {}) {
    const agent = registry.get(agentKind);
    const entry = cached(agentKind);
    if (!force && entry?.fresh) {
      const { fresh, ...result } = entry;
      return result;
    }

    const pending = refresh(agent);
    if (maxWaitMs === null) return pending;

    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), maxWaitMs));
    const result = await Promise.race([pending, timeout]);
    if (result) return result;

    // 超时：有旧状态就沿用并标记 stale，没有就明确说未知，两者都不阻塞调用方。
    if (entry) {
      const { fresh, ...previous } = entry;
      return { ...previous, stale: true };
    }
    return {
      kind: agentKind,
      ...unknownRuntimeStatus(`${agent.label} 的状态检测超时。`),
      checkedAt: new Date(now()).toISOString(),
      stale: false,
    };
  }

  return {
    get,
    /** 首页首次进入与手动刷新走这条；每个 Agent 用它自己的完整探测超时。 */
    list: ({ force = false } = {}) => Promise.all(
      registry.list().map((agent) => get(agent.id, { force })),
    ),
    /** 交互路径：优先用 10 秒内的缓存，过期时最多等 1.5 秒。 */
    forInteraction: (agentKind) => get(agentKind, { maxWaitMs: INTERACTIVE_WAIT_MS }),
    /** 窗口重新获得焦点时只在缓存过期的情况下后台刷新。 */
    hasFresh: (agentKind) => Boolean(cached(agentKind)?.fresh),
  };
}
