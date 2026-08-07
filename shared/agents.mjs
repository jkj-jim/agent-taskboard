/**
 * The single source of truth for which coding agents the taskboard supports.
 *
 * The server, the Cloudflare Worker, the CLI, and the web UI all read this
 * table, so adding an agent means adding one entry here plus one adapter under
 * `server/agents/`. Nothing else may branch on an agent name.
 */
export const AGENTS = [
  {
    kind: "codex",
    label: "Codex",
    actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
    assigneeTarget: "codex-agent",
    sessionEnvVar: "CODEX_THREAD_ID",
  },
  {
    kind: "claude",
    label: "Claude Code",
    actor: { type: "agent", id: "claude-agent", name: "Claude Agent", avatarUrl: null },
    assigneeTarget: "claude-agent",
    sessionEnvVar: "CLAUDE_CODE_SESSION_ID",
  },
];

/** Threads and attributions created before multi-agent support are Codex's. */
export const DEFAULT_AGENT_KIND = "codex";

export const AGENT_KINDS = AGENTS.map((agent) => agent.kind);

export const ASSIGNEE_TARGETS = [
  "current-user",
  ...AGENTS.map((agent) => agent.assigneeTarget),
];

export function agentByKind(value) {
  return AGENTS.find((agent) => agent.kind === value);
}

export function agentByAssigneeTarget(value) {
  return AGENTS.find((agent) => agent.assigneeTarget === value);
}

export function agentByActorId(value) {
  return AGENTS.find((agent) => agent.actor.id === value);
}

export function isAgentKind(value) {
  return AGENT_KINDS.includes(value);
}

export function isAssigneeTarget(value) {
  return ASSIGNEE_TARGETS.includes(value);
}
