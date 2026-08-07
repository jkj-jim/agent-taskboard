import claudeCodeLogo from "@lobehub/icons-static-svg/icons/claudecode-color.svg";
import { AGENTS, agentByActorId, agentByKind } from "../../shared/agents.mjs";
import type { ActorIdentity, AgentKind } from "./types";

export { AGENTS, agentByActorId, agentByKind };

const CODEX_LOGO = "/codex-agent-logo.png";

const AGENT_LOGOS: Record<AgentKind, string> = {
  codex: CODEX_LOGO,
  claude: claudeCodeLogo,
};

export function agentLabel(kind: AgentKind): string {
  return agentByKind(kind)?.label ?? kind;
}

/** The brand mark shown for an agent actor; users keep their own avatar. */
export function agentAvatarSrc(actor: ActorIdentity): string {
  const kind = agentByActorId(actor.id)?.kind;
  return (kind && AGENT_LOGOS[kind]) || CODEX_LOGO;
}

/**
 * Deep links back into each agent's own client. Codex routes by thread, Claude
 * Code imports a CLI session by id.
 */
export function agentSessionLink(kind: AgentKind, sessionId: string): string | null {
  const id = sessionId.trim();
  if (!id) return null;
  if (kind === "codex") return `codex://threads/${encodeURIComponent(id)}`;
  if (kind === "claude") return `claude://resume?session=${encodeURIComponent(id)}`;
  return null;
}

/** Opens a fresh conversation in the agent's client with the prompt prefilled. */
export function agentNewSessionLink(
  kind: AgentKind,
  { prompt, workspacePath }: { prompt: string; workspacePath?: string },
): string | null {
  if (kind === "codex") {
    const query = new URLSearchParams();
    if (workspacePath) query.set("path", workspacePath);
    query.set("prompt", prompt);
    return `codex://new?${query.toString().replace(/\+/g, "%20")}`;
  }
  if (kind === "claude") {
    const query = new URLSearchParams();
    query.set("q", prompt);
    if (workspacePath) query.append("folder", workspacePath);
    return `claude://code/new?${query.toString().replace(/\+/g, "%20")}`;
  }
  return null;
}
