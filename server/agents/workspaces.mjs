import { existingDirectory, loadDeviceWorkspaces } from "../ai-chat-catalog.mjs";

/**
 * Where each project is checked out on this device, for any agent.
 *
 * Three sources, most explicit last:
 *   1. the project→path map the Codex app maintains for this device
 *   2. the project's own `workspacePath` column
 *   3. the device mapping set through `taskctl project map`
 *
 * Sources 1 and 2 come from `loadDeviceWorkspaces`. Source 1 is written by
 * Codex but is really a device-wide map keyed by the same project ids the board
 * uses, so every agent may read it; without Codex installed it is simply absent.
 */
export function createDeviceWorkspaces({ codexStatePath, database, readProjectMappings }) {
  return async function deviceWorkspaces() {
    const workspaces = await loadDeviceWorkspaces(codexStatePath, database);
    const mappings = (await readProjectMappings?.()) ?? {};
    for (const [projectId, mappedPath] of Object.entries(mappings)) {
      const workspacePath = await existingDirectory(mappedPath);
      if (workspacePath) workspaces.set(projectId, workspacePath);
    }
    return workspaces;
  };
}
