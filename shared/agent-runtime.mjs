// Agent runtime 状态的公共词汇表（document/design/desktop-app-packaging.md §6）。
// 服务端与 Web 共同导入这里的常量，两边都不再各自维护字符串字面量。

export const AGENT_TRANSPORTS = [
  "native-draft",
  "native-submit",
  "host-draft",
  "host-submit",
  "headless",
];

export const AGENT_RUNTIME_STATUSES = [
  "ready",
  "needs_auth",
  "needs_setup",
  "unavailable",
  "unknown",
];

export const AGENT_RUNTIME_REASON_CODES = [
  "CLAUDE_AUTH_REQUIRED",
  "CODEX_AUTH_REQUIRED",
  "WORKBUDDY_AUTH_REQUIRED",
  "SKILL_LINK_CONFLICT",
  "AGENT_NOT_INSTALLED",
  "AGENT_STATUS_UNKNOWN",
];

export const RUNTIME_SETUP_ACTION_KINDS = [
  "terminal-command",
  "deep-link",
  "app-action",
  "internal-route",
  "external-url",
  "message",
];

// UI 只会执行这三个 app action，服务端返回别的一律拒绝。
export const RUNTIME_SETUP_APP_ACTION_IDS = [
  "open-codex-login",
  "open-workbuddy-authorization",
  "configure-workbuddy",
  "refresh-agent-status",
];

// 一期不引导下载：Agent 装在哪、从哪装由用户自己决定，看板只如实报状态。
export const AGENT_DOWNLOAD_URLS = {};

// internal-route 只允许看板自己的这些页面。
export const RUNTIME_SETUP_INTERNAL_ROUTES = ["/settings/skills/manage-taskboard"];

export function isAgentTransport(value) {
  return AGENT_TRANSPORTS.includes(value);
}

export function isAgentRuntimeStatus(value) {
  return AGENT_RUNTIME_STATUSES.includes(value);
}

export function isAgentRuntimeReasonCode(value) {
  return AGENT_RUNTIME_REASON_CODES.includes(value);
}

/**
 * 服务端在返回前校验动作，避免把不在 allowlist 里的命令或 URL 递给 UI。
 * 终端命令只展示不执行，所以 `autoRunnable` 必须为 false。
 */
export function assertRuntimeSetupAction(action) {
  if (action === undefined || action === null) return null;
  if (typeof action !== "object") throw new Error("RuntimeSetupAction must be an object");
  if (!RUNTIME_SETUP_ACTION_KINDS.includes(action.kind)) {
    throw new Error(`Unknown RuntimeSetupAction kind: ${action.kind}`);
  }
  for (const field of ["label", "message"]) {
    if (typeof action[field] !== "string" || action[field].length === 0) {
      throw new Error(`RuntimeSetupAction.${field} is required`);
    }
  }

  switch (action.kind) {
    case "terminal-command":
      if (typeof action.command !== "string" || action.command.length === 0) {
        throw new Error("terminal-command requires a command");
      }
      if (action.autoRunnable !== false) {
        throw new Error("terminal-command must not be auto-runnable");
      }
      break;
    case "app-action":
      if (!RUNTIME_SETUP_APP_ACTION_IDS.includes(action.actionId)) {
        throw new Error(`Unknown app action: ${action.actionId}`);
      }
      break;
    case "internal-route":
      if (!RUNTIME_SETUP_INTERNAL_ROUTES.includes(action.route)) {
        throw new Error(`Unknown internal route: ${action.route}`);
      }
      break;
    case "external-url":
      if (!Object.values(AGENT_DOWNLOAD_URLS).includes(action.url)) {
        throw new Error(`external-url must be a preset download page, got: ${action.url}`);
      }
      break;
    case "deep-link":
      if (typeof action.url !== "string" || !action.url.includes("://")) {
        throw new Error("deep-link requires a URL scheme");
      }
      break;
    case "message":
      if (action.autoRunnable !== false) {
        throw new Error("message actions must not be auto-runnable");
      }
      break;
    default:
      break;
  }
  return action;
}

/**
 * 状态区展示 `statusMessage`（为什么处于当前状态），动作说明随按钮展示
 * （执行该动作会发生什么）；两者不互相替代。
 */
export function assertAgentRuntimeStatus(runtime) {
  if (!isAgentRuntimeStatus(runtime.status)) {
    throw new Error(`Unknown agent runtime status: ${runtime.status}`);
  }
  if (!Array.isArray(runtime.transports) || !runtime.transports.every(isAgentTransport)) {
    throw new Error(`Unknown agent transport in: ${JSON.stringify(runtime.transports)}`);
  }
  if (runtime.reasonCode !== undefined && !isAgentRuntimeReasonCode(runtime.reasonCode)) {
    throw new Error(`Unknown agent runtime reason code: ${runtime.reasonCode}`);
  }
  assertRuntimeSetupAction(runtime.action);
  return runtime;
}

export const REFRESH_AGENT_STATUS_ACTION = {
  kind: "app-action",
  label: "重新检测",
  message: "重新运行一次该 Agent 的可用性检测。",
  autoRunnable: true,
  actionId: "refresh-agent-status",
};

/**
 * WorkBuddy 的 MCP 连接由看板自己写，不需要用户填任何路径或端口（§11）。
 * 这里给的是「点一下就配好」的动作，不是一个把人甩去下载页的链接。
 */
export const CONFIGURE_WORKBUDDY_ACTION = {
  kind: "app-action",
  label: "配置",
  message: "由看板写入 WorkBuddy 的 MCP 连接并验证握手；写入前会自动备份现有配置。",
  autoRunnable: true,
  actionId: "configure-workbuddy",
};

/** 探测不出结论时的统一结果：不可用与「这次没测出来」必须区分开。 */
export function unknownRuntimeStatus(statusMessage) {
  return {
    status: "unknown",
    transports: [],
    reasonCode: "AGENT_STATUS_UNKNOWN",
    statusMessage,
    action: REFRESH_AGENT_STATUS_ACTION,
  };
}
