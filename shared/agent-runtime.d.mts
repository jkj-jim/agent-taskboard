export declare const AGENT_TRANSPORTS: readonly [
  "native-draft",
  "native-submit",
  "host-draft",
  "host-submit",
  "headless",
];

export declare const AGENT_RUNTIME_STATUSES: readonly [
  "ready",
  "needs_auth",
  "needs_setup",
  "unavailable",
  "unknown",
];

export declare const AGENT_RUNTIME_REASON_CODES: readonly [
  "CLAUDE_AUTH_REQUIRED",
  "CODEX_AUTH_REQUIRED",
  "CODEX_DESKTOP_UNAVAILABLE",
  "WORKBUDDY_DESKTOP_UNAVAILABLE",
  "WORKBUDDY_AUTH_REQUIRED",
  "SKILL_LINK_CONFLICT",
  "AGENT_NOT_INSTALLED",
  "AGENT_STATUS_UNKNOWN",
];

export declare const RUNTIME_SETUP_ACTION_KINDS: readonly [
  "terminal-command",
  "deep-link",
  "app-action",
  "internal-route",
  "external-url",
  "message",
];

export declare const RUNTIME_SETUP_APP_ACTION_IDS: readonly [
  "open-codex-login",
  "open-workbuddy-authorization",
  "configure-workbuddy",
  "connect-workbuddy-desktop",
  "connect-codex-desktop",
  "refresh-agent-status",
];

export declare const AGENT_DOWNLOAD_URLS: Readonly<Record<AgentKind, string>>;

export declare const RUNTIME_SETUP_INTERNAL_ROUTES: readonly string[];

export declare function isAgentTransport(value: unknown): boolean;
export declare function isAgentRuntimeStatus(value: unknown): boolean;
export declare function isAgentRuntimeReasonCode(value: unknown): boolean;
export declare function assertRuntimeSetupAction<T>(action: T): T | null;
export declare function assertAgentRuntimeStatus<T>(runtime: T): T;
export declare const CONFIGURE_WORKBUDDY_ACTION: unknown;
export declare const CONNECT_WORKBUDDY_ACTION: unknown;
export declare function unknownRuntimeStatus(statusMessage: string): unknown;
export declare const REFRESH_AGENT_STATUS_ACTION: unknown;
