import {
  AGENTS,
  agentByActorId,
  agentByAssigneeTarget,
} from "../../shared/agents.mjs";
import type { ActorIdentity, AssigneeTarget } from "./types";

/** Every selectable agent assignee, in registry order. */
export const AGENT_ACTORS: ActorIdentity[] = AGENTS.map((agent) => agent.actor);

export function actorKey(actor: ActorIdentity): string {
  return `${actor.type}:${actor.id}`;
}

export function actorForAssigneeTarget(
  target: AssigneeTarget,
  currentUser: ActorIdentity,
): ActorIdentity {
  return agentByAssigneeTarget(target)?.actor ?? currentUser;
}

export function assigneeTargetForActor(
  actor: ActorIdentity,
  currentUser: ActorIdentity,
): AssigneeTarget | undefined {
  if (actor.type === "agent") return agentByActorId(actor.id)?.assigneeTarget;
  return actor.id === currentUser.id ? "current-user" : undefined;
}
