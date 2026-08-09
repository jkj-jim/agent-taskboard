import { ApiError } from "../database.mjs";
import { DEFAULT_AGENT_KIND } from "../../shared/agents.mjs";
import { createClaudeAgent } from "./claude.mjs";
import { createCodexAgent } from "./codex.mjs";

export { spawnAgentTurn } from "./spawn.mjs";
export { DEFAULT_AGENT_KIND };

/**
 * Every agent difference lives behind this registry. Call sites outside
 * `server/agents/` must look agents up here instead of branching on a kind.
 *
 * An agent exposes:
 *   id, label, actor, assigneeTarget, executable
 *   preassignsSessionId, createSessionId?, sessionExists(id)
 *   resolveWorkspace(projectId) -> { workspacePath, addDirectories, project }
 *   catalog(projectId)          -> { models, skills, sandboxes }
 *   buildTurn(input)            -> { args, cwd, prompt }
 *   createDecoder()             -> (rawEvent) => normalizedEvent[]
 *   resumeLink?(id), newSessionLink?(input)
 */
export function createAgentRegistry(config) {
  const agents = new Map([
    ["codex", createCodexAgent(config.codex)],
    ["claude", createClaudeAgent(config.claude)],
  ]);

  return {
    ids: [...agents.keys()],
    list: () => [...agents.values()],
    has: (agentKind) => agents.has(agentKind),
    get(agentKind = DEFAULT_AGENT_KIND) {
      const agent = agents.get(agentKind);
      if (!agent) {
        throw new ApiError(400, "INVALID_AGENT", `Unknown agent '${agentKind}'`);
      }
      return agent;
    },
    /** Resolves the `assigneeTarget` wire value (e.g. `claude-agent`). */
    byAssigneeTarget(target) {
      return [...agents.values()].find((agent) => agent.assigneeTarget === target) ?? null;
    },
  };
}

export function agentActors(registry) {
  return Object.fromEntries(registry.list().map((agent) => [agent.id, agent.actor]));
}
