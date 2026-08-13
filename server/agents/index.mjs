import { ApiError } from "../database.mjs";
import { DEFAULT_AGENT_KIND } from "../../shared/agents.mjs";
import { createClaudeAgent } from "./claude.mjs";
import { createCodexAgent } from "./codex.mjs";
import { createWorkbuddyAgent } from "./workbuddy.mjs";

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
 *   buildTurn(input)            -> { args, cwd, prompt, env? }
 *                                 `env` overlays the shared turn environment
 *   createDecoder()             -> (rawEvent) => normalizedEvent[]
 *   resumeLink?(id), newSessionLink?(input)
 */
export function createAgentRegistry(config) {
  const agents = new Map([
    ["codex", createCodexAgent(config.codex)],
    ["claude", createClaudeAgent(config.claude)],
    ["workbuddy", createWorkbuddyAgent(config.workbuddy)],
  ]);

  return {
    ids: [...agents.keys()],
    list: () => [...agents.values()],
    has: (agentKind) => agents.has(agentKind),
    /** Agents the board can run a turn for itself, i.e. those with an AI chat. */
    headless: () => [...agents.values()].filter((agent) => agent.capabilities?.headless !== false),
    get(agentKind = DEFAULT_AGENT_KIND) {
      const agent = agents.get(agentKind);
      if (!agent) {
        throw new ApiError(400, "INVALID_AGENT", `Unknown agent '${agentKind}'`);
      }
      return agent;
    },
    /**
     * The gate for anything the board runs itself. Host-launch-only agents have
     * no catalog, workspace or turn, so asking for one must fail here with a
     * readable reason rather than deeper inside the AI chat.
     */
    getHeadless(agentKind = DEFAULT_AGENT_KIND) {
      const agent = this.get(agentKind);
      if (agent.capabilities?.headless === false) {
        throw new ApiError(
          409,
          "AGENT_HEADLESS_UNSUPPORTED",
          `${agent.label} 不能在看板里直接对话，请把任务分配给它并在它的客户端中唤起`,
        );
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
