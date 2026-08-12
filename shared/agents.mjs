/**
 * The single source of truth for which coding agents the taskboard supports.
 *
 * The server, the Cloudflare Worker, the CLI, and the web UI all read this
 * table, so adding an agent means adding one entry here plus one adapter under
 * `server/agents/`. Nothing else may branch on an agent name.
 */
/**
 * `capabilities` is how call sites ask what an agent can do instead of testing
 * its name:
 *   headless   the board can spawn a turn itself and stream the events
 *   hostLaunch the board can only wake a session inside the agent's own client
 *   boardAccess how the agent reads and writes the board from its side
 */
export const AGENTS = [
  {
    kind: "codex",
    label: "Codex",
    actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
    assigneeTarget: "codex-agent",
    sessionEnvVar: "CODEX_THREAD_ID",
    capabilities: { headless: true, hostLaunch: true, boardAccess: "taskctl" },
  },
  {
    kind: "claude",
    label: "Claude Code",
    actor: { type: "agent", id: "claude-agent", name: "Claude Agent", avatarUrl: null },
    assigneeTarget: "claude-agent",
    sessionEnvVar: "CLAUDE_CODE_SESSION_ID",
    capabilities: { headless: true, hostLaunch: false, boardAccess: "taskctl" },
  },
  {
    kind: "workbuddy",
    label: "WorkBuddy",
    actor: { type: "agent", id: "workbuddy-agent", name: "WorkBuddy Agent", avatarUrl: null },
    assigneeTarget: "workbuddy-agent",
    /** WorkBuddy has no CLI, so no session ever announces itself through env. */
    sessionEnvVar: null,
    capabilities: { headless: false, hostLaunch: true, boardAccess: "mcp" },
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

/** Agents whose turns the board can run itself, i.e. those with an AI chat. */
export const HEADLESS_AGENT_KINDS = AGENTS
  .filter((agent) => agent.capabilities.headless)
  .map((agent) => agent.kind);

/** Env variables that let `taskctl` recognise the session calling it. */
export const SESSION_ENV_VARS = AGENTS
  .map((agent) => agent.sessionEnvVar)
  .filter((name) => typeof name === "string" && name.length > 0);
