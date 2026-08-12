import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Makes the board reachable from inside WorkBuddy. Two independent pieces:
 *
 *   MCP server   the operations layer. WorkBuddy reads user servers from
 *                `~/.workbuddy/mcp.json`; the `.mcp.json` sibling is generated
 *                by the client and must not be touched.
 *   Skill        the workflow rules. `~/.workbuddy/skills/<name>/SKILL.md` is
 *                scanned on startup, the same layout this repo already ships.
 *
 * WorkBuddy has no CLI and the board cannot influence the environment of the
 * agent process it spawns, so `taskctl` on PATH — the way Codex reaches the
 * board — is not available here. MCP replaces that layer; the skill keeps
 * carrying the process rules so they are not duplicated in tool descriptions.
 */

export const WORKBUDDY_SERVER_NAME = "taskboard";

export function workbuddyHomeDirectory(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, ".workbuddy");
}

export function workbuddyMcpConfigPath(homeDirectory = os.homedir()) {
  return path.join(workbuddyHomeDirectory(homeDirectory), "mcp.json");
}

export function workbuddySkillsDirectory(homeDirectory = os.homedir()) {
  return path.join(workbuddyHomeDirectory(homeDirectory), "skills");
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new Error(`${filePath} 不是合法的 JSON，请先修复它再启动 WorkBuddy 任务`);
    }
    throw error;
  }
}

function mcpEntry(origin, description) {
  return {
    type: "http",
    url: `${origin.replace(/\/+$/, "")}/mcp`,
    description,
    disabled: false,
  };
}

function sameEntry(existing, wanted) {
  if (!existing || typeof existing !== "object") return false;
  return existing.type === wanted.type
    && existing.url === wanted.url
    && existing.description === wanted.description
    && existing.disabled === wanted.disabled;
}

/**
 * The board's entry as WorkBuddy currently has it, or null when absent.
 *
 * Note what this cannot tell you: WorkBuddy's proxy connects lazily and closes
 * the connection again, so an idle socket says nothing about whether the link
 * works. The configuration is the only honest precondition to check.
 */
export async function readMcpRegistration({
  serverName = WORKBUDDY_SERVER_NAME,
  homeDirectory = os.homedir(),
} = {}) {
  const config = await readJsonFile(workbuddyMcpConfigPath(homeDirectory));
  const entry = config?.mcpServers?.[serverName];
  if (!entry || typeof entry !== "object") return null;
  return { ...entry, disabled: entry.disabled === true };
}

/** Whether something is already answering MCP on a registered URL. */
async function endpointAnswers(url, fetchImplementation = globalThis.fetch) {
  try {
    const response = await fetchImplementation(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Registers the board's MCP endpoint, preserving every other server the user
 * configured.
 *
 * An existing `taskboard` entry is left alone while it still answers. WorkBuddy
 * ties its trust to the server's configuration, so rewriting a URL the user has
 * already approved silently breaks a working setup — the tools simply vanish
 * from the agent and it starts hunting for a CLI instead. A registration is
 * only replaced when nothing answers on it any more.
 */
export async function ensureMcpRegistration({
  origin,
  description,
  serverName = WORKBUDDY_SERVER_NAME,
  homeDirectory = os.homedir(),
  probeEndpoint = endpointAnswers,
} = {}) {
  if (typeof origin !== "string" || !/^https?:\/\//.test(origin)) {
    throw new Error("MCP registration needs the board's http origin");
  }
  const configPath = workbuddyMcpConfigPath(homeDirectory);
  const existing = await readJsonFile(configPath);
  const wanted = mcpEntry(origin, description);
  const servers = existing?.mcpServers && typeof existing.mcpServers === "object"
    ? existing.mcpServers
    : {};
  const current = servers[serverName];

  if (sameEntry(current, wanted)) {
    return { path: configPath, changed: false, serverName, url: wanted.url };
  }

  if (current?.url && current.url !== wanted.url && await probeEndpoint(current.url)) {
    return {
      path: configPath,
      changed: false,
      keptExisting: true,
      serverName,
      url: current.url,
      boardUrl: wanted.url,
    };
  }

  const next = { ...existing, mcpServers: { ...servers, [serverName]: wanted } };
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { path: configPath, changed: true, serverName, url: wanted.url };
}

/**
 * Copies the board's skill into WorkBuddy's skill directory. Copying rather
 * than symlinking because the client scans real files, and a stale copy would
 * silently teach the agent outdated rules.
 */
export async function ensureSkillInstalled({
  skillPath,
  homeDirectory = os.homedir(),
} = {}) {
  if (typeof skillPath !== "string" || skillPath.length === 0) {
    throw new Error("Skill installation needs the source skill directory");
  }
  const source = await readFile(path.join(skillPath, "SKILL.md"), "utf8").catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`${skillPath} 下没有 SKILL.md，无法同步到 WorkBuddy`);
    }
    throw error;
  });
  const name = path.basename(skillPath);
  const destination = path.join(workbuddySkillsDirectory(homeDirectory), name);
  const installed = await readFile(path.join(destination, "SKILL.md"), "utf8").catch(() => null);
  if (installed === source) {
    return { path: destination, changed: false, name };
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await cp(skillPath, destination, { recursive: true });
  return { path: destination, changed: true, name };
}

/**
 * Both halves at once, so a launch only has to make one call.
 *
 * Writing the config is not enough to make the tools usable: WorkBuddy trusts a
 * server only after the user enables it once, and that trust is keyed to the
 * server's configuration — changing the URL invalidates it. The board cannot
 * and should not forge that decision, so a changed registration is reported as
 * `requiresApproval` with the exact place to click.
 */
export async function ensureWorkbuddyBoardAccess({
  origin,
  description,
  skillPath,
  serverName = WORKBUDDY_SERVER_NAME,
  homeDirectory = os.homedir(),
}) {
  const mcp = await ensureMcpRegistration({
    origin,
    description,
    serverName,
    homeDirectory,
  });
  const skill = skillPath
    ? await ensureSkillInstalled({ skillPath, homeDirectory })
    : { path: null, changed: false, name: null };
  return {
    mcp,
    skill,
    requiresApproval: mcp.changed,
    approvalHint: mcp.changed
      ? `在 WorkBuddy 的「专家·技能·连接器 → 连接器 → MCP 服务管理」中启用 ${serverName}，然后重启 WorkBuddy。`
      : "",
  };
}
