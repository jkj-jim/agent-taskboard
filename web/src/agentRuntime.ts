import { useCallback, useEffect, useRef, useState } from "react";

import { AGENT_DOWNLOAD_URLS } from "../../shared/agent-runtime.mjs";
import { getAgentRuntimeStatuses } from "./api";
import type {
  AgentKind,
  AgentRuntimeStatus,
  AgentRuntimeSnapshot,
  RuntimeSetupAction,
} from "./types";

export const RUNTIME_STATE_LABELS: Record<AgentRuntimeStatus["status"], string> = {
  ready: "可用",
  needs_auth: "待登录",
  needs_setup: "待配置",
  unavailable: "不可用",
  unknown: "状态未知",
};

export function runtimeStateLabel(runtime: AgentRuntimeStatus | undefined): string {
  if (runtime?.reasonCode === "WORKBUDDY_DESKTOP_UNAVAILABLE") return "待连接";
  return RUNTIME_STATE_LABELS[runtime?.status ?? "unknown"];
}

/**
 * 首页与负责人下拉共用的唯一 runtime 状态源：首次进入拉一次，窗口重新获得焦点时
 * 后台刷新（服务端 10 秒缓存决定是否真的重测），手动刷新强制重测。
 */
export function useAgentRuntime() {
  const [snapshot, setSnapshot] = useState<AgentRuntimeSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async (force = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (force) setRefreshing(true);
    try {
      setSnapshot(await getAgentRuntimeStatuses(force));
    } catch {
      // 探测失败不该打断看板本身；保留上一次结果，下一次刷新再试。
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    const onFocus = () => void load(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  return {
    agents: snapshot?.agents ?? [],
    defaultAgentKind: snapshot?.defaultAgentKind ?? null,
    loaded: snapshot !== null,
    refreshing,
    refresh: () => load(true),
  };
}

export function runtimeFor(
  agents: AgentRuntimeStatus[],
  kind: AgentKind | undefined,
): AgentRuntimeStatus | undefined {
  return kind ? agents.find((agent) => agent.kind === kind) : undefined;
}

export function isReady(agents: AgentRuntimeStatus[], kind: AgentKind | undefined): boolean {
  return runtimeFor(agents, kind)?.status === "ready";
}

const ALLOWED_EXTERNAL_URLS = new Set<string>(Object.values(AGENT_DOWNLOAD_URLS));

/**
 * allowlist dispatcher：只执行 app action、deep link、内部路由和预置官方 URL。
 * 终端命令永远只复制，绝不代跑。返回 false 表示这个动作没有可自动执行的部分。
 */
export function runSetupAction(
  action: RuntimeSetupAction,
  handlers: {
    refresh: () => void;
    openInternalRoute: (route: string) => void;
    notify: (message: string) => void;
    configureWorkbuddy?: () => void;
    connectWorkbuddyDesktop?: () => void;
    connectCodexDesktop?: () => void;
  },
): boolean {
  switch (action.kind) {
    case "app-action":
      if (action.actionId === "refresh-agent-status") {
        handlers.refresh();
        return true;
      }
      if (action.actionId === "configure-workbuddy" && handlers.configureWorkbuddy) {
        handlers.configureWorkbuddy();
        return true;
      }
      if (action.actionId === "connect-workbuddy-desktop" && handlers.connectWorkbuddyDesktop) {
        handlers.connectWorkbuddyDesktop();
        return true;
      }
      if (action.actionId === "connect-codex-desktop" && handlers.connectCodexDesktop) {
        handlers.connectCodexDesktop();
        return true;
      }
      // 其余 app action 由 Tauri 协调（隔离 Codex 登录窗口、WorkBuddy 授权入口），
      // 尚未接通前明确告知，而不是静默失败。
      handlers.notify(action.message);
      return false;
    case "internal-route":
      handlers.openInternalRoute(action.route);
      return true;
    case "external-url":
      if (!ALLOWED_EXTERNAL_URLS.has(action.url)) return false;
      window.open(action.url, "_blank", "noopener,noreferrer");
      return true;
    case "deep-link":
      window.location.href = action.url;
      return true;
    case "terminal-command":
      void navigator.clipboard?.writeText(action.command);
      handlers.notify(`已复制：${action.command}`);
      return true;
    default:
      return false;
  }
}
