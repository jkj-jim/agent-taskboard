export type AgentKind = "codex" | "claude";

export type AgentAssigneeTarget = "codex-agent" | "claude-agent";

export type AssigneeTarget = "current-user" | AgentAssigneeTarget;

export interface AgentActor {
  readonly type: "agent";
  readonly id: AgentAssigneeTarget;
  readonly name: string;
  readonly avatarUrl: null;
}

export interface AgentDefinition {
  readonly kind: AgentKind;
  readonly label: string;
  readonly actor: AgentActor;
  readonly assigneeTarget: AgentAssigneeTarget;
  readonly sessionEnvVar: string;
}

export const AGENTS: readonly AgentDefinition[];
export const DEFAULT_AGENT_KIND: AgentKind;
export const AGENT_KINDS: readonly AgentKind[];
export const ASSIGNEE_TARGETS: readonly AssigneeTarget[];

export function agentByKind(value: unknown): AgentDefinition | undefined;
export function agentByAssigneeTarget(value: unknown): AgentDefinition | undefined;
export function agentByActorId(value: unknown): AgentDefinition | undefined;
export function isAgentKind(value: unknown): value is AgentKind;
export function isAssigneeTarget(value: unknown): value is AssigneeTarget;
