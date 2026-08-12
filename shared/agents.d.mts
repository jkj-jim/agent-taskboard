export type AgentKind = "codex" | "claude" | "workbuddy";

export type AgentAssigneeTarget = "codex-agent" | "claude-agent" | "workbuddy-agent";

export type AssigneeTarget = "current-user" | AgentAssigneeTarget;

export interface AgentActor {
  readonly type: "agent";
  readonly id: AgentAssigneeTarget;
  readonly name: string;
  readonly avatarUrl: null;
}

/** How the board reaches an agent, asked by capability instead of by name. */
export interface AgentCapabilities {
  /** The board can spawn a turn itself and stream its events. */
  readonly headless: boolean;
  /** The board can only wake a session inside the agent's own client. */
  readonly hostLaunch: boolean;
  /** How the agent reads and writes the board from its side. */
  readonly boardAccess: "taskctl" | "mcp";
}

export interface AgentDefinition {
  readonly kind: AgentKind;
  readonly label: string;
  readonly actor: AgentActor;
  readonly assigneeTarget: AgentAssigneeTarget;
  /** Null for agents without a CLI, which never announce a session via env. */
  readonly sessionEnvVar: string | null;
  readonly capabilities: AgentCapabilities;
}

export const AGENTS: readonly AgentDefinition[];
export const DEFAULT_AGENT_KIND: AgentKind;
export const AGENT_KINDS: readonly AgentKind[];
export const ASSIGNEE_TARGETS: readonly AssigneeTarget[];
export const HEADLESS_AGENT_KINDS: readonly AgentKind[];
export const SESSION_ENV_VARS: readonly string[];

export function agentByKind(value: unknown): AgentDefinition | undefined;
export function agentByAssigneeTarget(value: unknown): AgentDefinition | undefined;
export function agentByActorId(value: unknown): AgentDefinition | undefined;
export function isAgentKind(value: unknown): value is AgentKind;
export function isAssigneeTarget(value: unknown): value is AssigneeTarget;
