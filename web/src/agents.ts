import claudeCodeLogo from "@lobehub/icons-static-svg/icons/claudecode-color.svg";
import tencentLogo from "@lobehub/icons-static-svg/icons/tencent-brand-color.svg";
import { AGENTS, agentByActorId, agentByKind } from "../../shared/agents.mjs";
import type { ActorIdentity, AgentKind } from "./types";

export { AGENTS, agentByActorId, agentByKind };

const CODEX_LOGO = "/codex-agent-logo.png";

const AGENT_LOGOS: Record<AgentKind, string> = {
  codex: CODEX_LOGO,
  claude: claudeCodeLogo,
  // WorkBuddy ships no standalone mark here, so its vendor brand stands in.
  workbuddy: tencentLogo,
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
 * Code imports a CLI session by id. WorkBuddy has no URL routing at all — its
 * renderer never leaves a single file URL — so reopening a session there goes
 * through the board's own endpoint instead of a link.
 */
export function agentSessionLink(kind: AgentKind, sessionId: string): string | null {
  const id = sessionId.trim();
  if (!id) return null;
  if (kind === "codex") return `codex://threads/${encodeURIComponent(id)}`;
  if (kind === "claude") return `claude://resume?session=${encodeURIComponent(id)}`;
  return null;
}

/** Agents whose sessions the board reopens by driving their client. */
export function agentSessionOpenEndpoint(kind: AgentKind, sessionId: string): string | null {
  const id = sessionId.trim();
  if (!id || kind !== "workbuddy") return null;
  return `/api/local/workbuddy/sessions/${encodeURIComponent(id)}/open`;
}

/**
 * Agents the board starts by driving their client rather than by opening a
 * link. Codex has its own dedicated route, so it is not listed here.
 */
export function agentTaskLaunchEndpoint(kind: AgentKind, taskId: string): string | null {
  if (kind !== "workbuddy") return null;
  return `/api/local/workbuddy/tasks/${encodeURIComponent(taskId)}/launch`;
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
