import { existingDirectory, loadDeviceWorkspaces } from "../ai-chat-catalog.mjs";
import { workspaceKey } from "../../shared/workspace-key.mjs";

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
  async function deviceWorkspaces() {
    const workspaces = await loadDeviceWorkspaces(codexStatePath, database);
    const mappings = (await readProjectMappings?.()) ?? {};
    for (const [projectId, mappedPath] of Object.entries(mappings)) {
      const workspacePath = await existingDirectory(mappedPath);
      if (workspacePath) workspaces.set(projectId, workspacePath);
    }
    return workspaces;
  }

  /**
   * 反向索引：规范化后的工作目录 → 指向它的项目 id。同一个目录被两个项目引用时
   * 它们共用一份 Codex 项目，而不是在 Codex 侧建出两个（§9、§12）。
   * 键必须规范化——大小写与 NFD/NFC 差异会让同一目录被判成两个。
   */
  deviceWorkspaces.byWorkspaceKey = async () => {
    const index = new Map();
    for (const [projectId, workspacePath] of await deviceWorkspaces()) {
      const key = workspaceKey(workspacePath);
      if (!index.has(key)) index.set(key, { workspacePath, projectIds: [] });
      index.get(key).projectIds.push(projectId);
    }
    return index;
  };

  return deviceWorkspaces;
}
