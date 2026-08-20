import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  TASK_STATUSES,
  isTaskPriority,
  isTaskStatus,
} from "../shared/domain.mjs";
import { APP_ID, PROFILE_DEVELOPMENT } from "../shared/app-identity.mjs";
import { APP_VERSION_FULL } from "../shared/app-version.generated.mjs";
import { normalizeWorkflowSnapshot } from "../shared/workflow-control-flow.mjs";
import {
  ASSIGNEE_TARGETS,
  DEFAULT_AGENT_KIND,
  agentByActorId,
  agentByAssigneeTarget,
  agentByKind,
  isAgentKind,
  isAssigneeTarget,
} from "../shared/agents.mjs";
import { AiChatService } from "./ai-chat.mjs";
import { createAgentRegistry } from "./agents/index.mjs";
import { createAgentLaunchCoordinator } from "./agents/launch.mjs";
import { renderClaudeTaskInstruction } from "./agents/task-instruction.mjs";
import { createAgentRuntimeStatuses } from "./agents/runtime-status.mjs";
import {
  applySkillTemplate,
  diffSkillAgainstTemplate,
  inspectSkillInstallation,
} from "./agents/skill-install.mjs";
import { createTaskctlRuntime } from "./agents/taskctl-bin.mjs";
import { createDeviceWorkspaces } from "./agents/workspaces.mjs";
import { workspaceKey } from "../shared/workspace-key.mjs";
import { createCloudConfigStore } from "./cloud-config.mjs";
import {
  createCodexDesktopController,
  createCodexTaskLaunchCoordinator,
} from "./codex-desktop-controller.mjs";
import { createWorkbuddyDesktopController } from "./workbuddy-desktop-controller.mjs";
import { ensureWorkbuddyBoardAccess, verifyMcpEndpoint } from "./workbuddy-host-setup.mjs";
import { createWorkbuddyTaskLaunchCoordinator } from "./workbuddy-task-launch.mjs";
import { createMcpService } from "./mcp.mjs";
import {
  CloudProxyError,
  createCloudProxy,
  isLocalCompanionRoute,
} from "./cloud-proxy.mjs";
import { ApiError, TaskboardDatabase } from "./database.mjs";
import { existingDirectory } from "./ai-chat-catalog.mjs";
import { chooseDirectory } from "./directory-dialog.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const JSON_BODY_LIMIT = 1024 * 1024;
const ATTACHMENT_BODY_LIMIT = 25 * 1024 * 1024;
const AI_CHAT_TURN_BODY_LIMIT = 25 * 1024 * 1024;
const AI_CHAT_ATTACHMENT_LIMIT = 10;
const AI_CHAT_SKILL_MARKER = "\uFFFC";
const INLINE_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);
const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TRUSTED_EMBED_ORIGINS = new Set(["app://-"]);
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, { "cache-control": "no-store", ...headers });
  response.end();
}

function toFetchRequest(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = Readable.toWeb(request);
    init.duplex = "half";
  }
  return new Request(`http://127.0.0.1${request.url}`, init);
}

async function sendFetchResponse(response, upstream) {
  response.statusCode = upstream.status;
  response.statusMessage = upstream.statusText;
  for (const [name, value] of upstream.headers) {
    if (
      name === "connection"
      || name === "content-encoding"
      || name === "content-length"
      || name === "set-cookie"
      || name === "transfer-encoding"
    ) {
      continue;
    }
    response.setHeader(name, value);
  }
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
  if (!upstream.body) {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const body = Readable.fromWeb(upstream.body);
    body.once("error", reject);
    response.once("finish", resolve);
    body.pipe(response);
  });
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isTrustedNetworkHost(hostname) {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 127
      || octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  if (isIP(host) === 6) {
    return host.startsWith("fc")
      || host.startsWith("fd")
      || /^fe[89ab]/.test(host);
  }
  return false;
}

function assertTrustedNetworkRequest(request) {
  let host;
  try {
    host = new URL(`http://${request.headers.host ?? ""}`).hostname;
  } catch {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local or private");
  }
  if (!isTrustedNetworkHost(host)) {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local or private");
  }

  const origin = request.headers.origin;
  if (!origin) return;
  if (TRUSTED_EMBED_ORIGINS.has(origin)) return;
  let originHost;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be local or private");
  }
  if (!isTrustedNetworkHost(originHost)) {
    throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be local or private");
  }
}

function assertLoopbackRequest(request) {
  const address = request.socket.remoteAddress;
  if (
    address !== "127.0.0.1"
    && address !== "::1"
    && address !== "::ffff:127.0.0.1"
  ) {
    throw new ApiError(403, "LOCAL_ONLY", "This endpoint is only available on this device");
  }
}

function assertPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "Request body must be a JSON object");
  }
}

function assertAllowedKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ApiError(400, "UNKNOWN_FIELD", `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

function assertAllowedQuery(searchParams, allowed, routeLabel) {
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `${routeLabel} does not accept query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }
}

function assertNoQuery(searchParams, routeLabel) {
  assertAllowedQuery(searchParams, new Set(), routeLabel);
}

function decodeRouteSegment(value, name) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ApiError(400, "INVALID_PATH", `${name} contains invalid encoding`);
  }
  if (!decoded || decoded.length > 256 || decoded.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", `${name} is invalid`);
  }
  return decoded;
}

function isLoopbackAddress(value) {
  if (typeof value !== "string") return false;
  const address = value.toLowerCase().split("%", 1)[0];
  return address === "::1"
    || address === "127.0.0.1"
    || address.startsWith("127.")
    || address === "::ffff:127.0.0.1"
    || address.startsWith("::ffff:127.");
}

function assertAiLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new ApiError(403, "LOCAL_AI_LOOPBACK_REQUIRED", "Local AI routes are only available from this device");
  }
}

function stringField(value, name, { required = false, nullable = false, maxLength }) {
  if (value === undefined) {
    if (required) {
      throw new ApiError(400, "INVALID_FIELD", `'${name}' is required`);
    }
    return undefined;
  }
  if (nullable && value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must be a string${nullable ? " or null" : ""}`);
  }
  const normalized = value.trim();
  if (required && normalized.length === 0) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized.length > maxLength) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot exceed ${maxLength} characters`);
  }
  return normalized;
}

function pathField(value, name) {
  const normalized = stringField(value, name, { nullable: true, maxLength: 4096 });
  if (normalized === "") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized?.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot contain null bytes`);
  }
  return normalized;
}

function parseDueDate(value, name = "dueDate") {
  const date = stringField(value, name, { nullable: true, maxLength: 10 });
  if (date !== null && date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must use YYYY-MM-DD`);
  }
  return date;
}

function parseDevelopmentContext(value) {
  if (value === null) return null;
  assertPlainObject(value);
  if (value.type === "branch") {
    assertAllowedKeys(value, new Set(["type", "branch"]));
    return {
      type: "branch",
      branch: stringField(value.branch, "developmentContext.branch", { required: true, maxLength: 512 }),
    };
  }
  if (value.type === "worktree") {
    assertAllowedKeys(value, new Set(["type", "path", "branch"]));
    const worktreePath = stringField(value.path, "developmentContext.path", { required: true, maxLength: 4096 });
    if (worktreePath.includes("\0")) {
      throw new ApiError(400, "INVALID_FIELD", "'developmentContext.path' cannot contain null bytes");
    }
    return {
      type: "worktree",
      path: worktreePath,
      branch: stringField(value.branch ?? null, "developmentContext.branch", { nullable: true, maxLength: 512 }),
    };
  }
  throw new ApiError(400, "INVALID_FIELD", "'developmentContext.type' must be branch or worktree");
}

function parseRecurrence(value) {
  if (value === null) return null;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["interval", "unit"]));
  if (!Number.isSafeInteger(value.interval) || value.interval < 1 || value.interval > 365) {
    throw new ApiError(400, "INVALID_FIELD", "'recurrence.interval' must be an integer from 1 to 365");
  }
  if (!["day", "week", "month", "year"].includes(value.unit)) {
    throw new ApiError(400, "INVALID_FIELD", "'recurrence.unit' must be day, week, month, or year");
  }
  return { interval: value.interval, unit: value.unit };
}

function parseVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, "INVALID_FIELD", "'version' must be a positive integer");
  }
  return value;
}

function parseWorkflowVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, "INVALID_FIELD", "'version' must be a non-negative integer");
  }
  return value;
}

function parseWorkflowWorkspace(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["version", "tabs", "activeWorkflowId", "snapshots"]));
  if (value.version !== 1) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.version' must be 1");
  }
  if (!Array.isArray(value.tabs) || value.tabs.length === 0 || value.tabs.length > 100) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.tabs' must contain 1 to 100 workflows");
  }
  const tabs = value.tabs.map((tab, index) => {
    assertPlainObject(tab);
    assertAllowedKeys(tab, new Set(["id", "name"]));
    return {
      id: stringField(tab.id, `workspace.tabs[${index}].id`, { required: true, maxLength: 128 }),
      name: stringField(tab.name, `workspace.tabs[${index}].name`, { required: true, maxLength: 120 }),
    };
  });
  if (new Set(tabs.map((tab) => tab.id)).size !== tabs.length) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.tabs' ids must be unique");
  }
  const activeWorkflowId = stringField(value.activeWorkflowId, "workspace.activeWorkflowId", {
    required: true,
    maxLength: 128,
  });
  if (!tabs.some((tab) => tab.id === activeWorkflowId)) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.activeWorkflowId' must reference a workflow tab");
  }
  assertPlainObject(value.snapshots);
  const snapshots = {};
  for (const tab of tabs) {
    const snapshot = value.snapshots[tab.id];
    assertPlainObject(snapshot);
    assertAllowedKeys(snapshot, new Set(["nodes", "edges", "flow", "selectedNodeId"]));
    if (!Array.isArray(snapshot.nodes) || snapshot.nodes.length > 10_000) {
      throw new ApiError(400, "INVALID_FIELD", `'workspace.snapshots.${tab.id}.nodes' must be an array`);
    }
    if (snapshot.flow === undefined && (!Array.isArray(snapshot.edges) || snapshot.edges.length > 20_000)) {
      throw new ApiError(400, "INVALID_FIELD", `'workspace.snapshots.${tab.id}.edges' must be an array`);
    }
    if (snapshot.flow !== undefined && snapshot.edges !== undefined) {
      throw new ApiError(400, "INVALID_FIELD", `'workspace.snapshots.${tab.id}' cannot contain both 'flow' and 'edges'`);
    }
    const selectedNodeId = stringField(
      snapshot.selectedNodeId ?? null,
      `workspace.snapshots.${tab.id}.selectedNodeId`,
      { nullable: true, maxLength: 256 },
    );
    try {
      snapshots[tab.id] = normalizeWorkflowSnapshot({
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        flow: snapshot.flow,
        selectedNodeId,
      });
    } catch (error) {
      throw new ApiError(
        400,
        "INVALID_FIELD",
        `'workspace.snapshots.${tab.id}' is not a valid workflow: ${error.message}`,
      );
    }
  }
  return { version: 1, tabs, activeWorkflowId, snapshots };
}

function parseWorkflowWorkspaceSave(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "workspace"]));
  return {
    version: parseWorkflowVersion(body.version),
    workspace: parseWorkflowWorkspace(body.workspace),
  };
}

function parseSortOrder(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) {
    throw new ApiError(400, "INVALID_FIELD", "'sortOrder' must be a finite number between -1000000000000 and 1000000000000");
  }
  return value;
}

function parseLabels(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'labels' must be an array with at most 20 entries");
  }
  const labels = value.map((label) => {
    if (typeof label !== "string") {
      throw new ApiError(400, "INVALID_FIELD", "Every label must be a string");
    }
    const normalized = label.trim();
    if (normalized.length === 0 || normalized.length > 64) {
      throw new ApiError(400, "INVALID_FIELD", "Labels must contain 1 to 64 characters");
    }
    return normalized;
  });
  if (new Set(labels).size !== labels.length) {
    throw new ApiError(400, "INVALID_FIELD", "Labels must be unique");
  }
  return labels;
}

function parseStatus(value, fallback) {
  const result = value ?? fallback;
  if (!isTaskStatus(result)) {
    throw new ApiError(400, "INVALID_FIELD", `'status' must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  return result;
}

function parsePriority(value, fallback) {
  const result = value ?? fallback;
  if (!isTaskPriority(result)) {
    throw new ApiError(400, "INVALID_FIELD", "'priority' must be none, urgent, high, medium, or low");
  }
  return result;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function validateProjectId(value, { required = true, field = "id" } = {}) {
  const id = stringField(value, field, { required, maxLength: 64 });
  if (id !== undefined && !PROJECT_ID_PATTERN.test(id)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      `'${field}' must be a lowercase slug containing letters, numbers, or hyphens`,
    );
  }
  return id;
}

/**
 * A readable id for a freshly picked folder, falling back to its path.
 *
 * The id shapes the identifier of every issue in the project, so a folder named
 * `agent-taskboard` should read as `AGENTTASKBOA-1` rather than as a digest.
 * Names that survive slugification empty — `知识流转系统`, say — or that collide
 * with an existing project fall back to the path digest, which keeps the same
 * folder mapping to the same id no matter when it is picked.
 */
function projectIdForDirectory(workspacePath, taken) {
  const digest = createHash("sha256").update(workspacePath).digest("hex");
  const base = slugify(path.basename(workspacePath)).slice(0, 50);
  const candidates = base ? [base, `${base}-${digest.slice(0, 6)}`] : [];
  for (const candidate of candidates) {
    if (PROJECT_ID_PATTERN.test(candidate) && !taken.has(candidate)) return candidate;
  }
  return `project-${digest.slice(0, 12)}`;
}

function parseProjectCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["id", "name", "workspacePath"]));
  const name = stringField(body.name, "name", { required: true, maxLength: 120 });
  const id = validateProjectId(body.id ?? slugify(name));
  if (!id) {
    throw new ApiError(400, "INVALID_FIELD", "Project name must contain at least one letter or number when 'id' is omitted");
  }
  const workspacePath = stringField(body.workspacePath ?? null, "workspacePath", { nullable: true, maxLength: 4096 });
  if (workspacePath === "") {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot be empty");
  }
  if (workspacePath?.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
  }
  return { id, name, workspacePath };
}

function parseThreadId(value) {
  if (value === undefined) return undefined;
  return stringField(value, "threadId", { required: true, maxLength: 256 });
}

function parseAgentSessionBinding(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["agentKind", "sessionId", "previousSessionId"]));
  if (!isAgentKind(body.agentKind)) {
    throw new ApiError(400, "INVALID_FIELD", "'agentKind' is not a supported agent");
  }
  if (!Object.hasOwn(body, "previousSessionId")) {
    throw new ApiError(400, "INVALID_FIELD", "'previousSessionId' is required");
  }
  return {
    agentKind: body.agentKind,
    sessionId: stringField(body.sessionId, "sessionId", { required: true, maxLength: 256 }),
    previousSessionId: stringField(body.previousSessionId, "previousSessionId", {
      nullable: true,
      maxLength: 256,
    }),
  };
}

function parseNativeCodexLaunch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "expectedVersion",
    "trigger",
    "presentation",
    "previousSessionId",
  ]));
  if (!new Set(["status-transition", "manual"]).has(body.trigger)) {
    throw new ApiError(400, "INVALID_FIELD", "'trigger' must be status-transition or manual");
  }
  if (!new Set(["background", "foreground"]).has(body.presentation)) {
    throw new ApiError(400, "INVALID_FIELD", "'presentation' must be background or foreground");
  }
  if (!Object.hasOwn(body, "previousSessionId")) {
    throw new ApiError(400, "INVALID_FIELD", "'previousSessionId' is required");
  }
  if (
    (body.trigger === "status-transition" && body.presentation !== "background")
    || (body.trigger === "manual" && body.presentation !== "foreground")
  ) {
    throw new ApiError(400, "INVALID_FIELD", "The launch trigger and presentation do not match");
  }
  return {
    expectedVersion: parseVersion(body.expectedVersion),
    trigger: body.trigger,
    presentation: body.presentation,
    previousSessionId: stringField(body.previousSessionId, "previousSessionId", {
      nullable: true,
      maxLength: 256,
    }),
  };
}

function requestHeader(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function actorFromRequest(request) {
  if (request.headers["x-taskboard-client"] === "taskctl") {
    // Older CLIs send no agent header; they were always Codex.
    const agentKind = requestHeader(request, "x-taskboard-agent") ?? DEFAULT_AGENT_KIND;
    const agent = agentByKind(agentKind);
    if (!agent) {
      throw new ApiError(400, "INVALID_ACTOR", `Unknown agent '${agentKind}'`);
    }
    return agent.actor;
  }

  const rawId = requestHeader(request, "x-taskboard-user-id");
  const rawName = requestHeader(request, "x-taskboard-user-name");
  const rawAvatarUrl = requestHeader(request, "x-taskboard-user-avatar");
  if (rawId === undefined && rawName === undefined && rawAvatarUrl === undefined) {
    return { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
  }
  if (rawId === undefined || rawName === undefined) {
    throw new ApiError(400, "INVALID_ACTOR", "User identity requires both an ID and name");
  }

  const id = stringField(rawId, "X-Taskboard-User-Id", { required: true, maxLength: 96 });
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id)) {
    throw new ApiError(400, "INVALID_ACTOR", "User ID contains unsupported characters");
  }
  let decodedName;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    throw new ApiError(400, "INVALID_ACTOR", "User name is not valid URL-encoded text");
  }
  const name = stringField(decodedName, "X-Taskboard-User-Name", { required: true, maxLength: 120 });

  let avatarUrl = null;
  if (rawAvatarUrl !== undefined) {
    const value = stringField(rawAvatarUrl, "X-Taskboard-User-Avatar", { required: true, maxLength: 2048 });
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new ApiError(400, "INVALID_ACTOR", "User avatar URL is invalid");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new ApiError(400, "INVALID_ACTOR", "User avatar URL must use HTTP or HTTPS");
    }
    avatarUrl = parsed.toString();
  }
  return { type: "user", id, name, avatarUrl };
}

/**
 * Ties the conversation a write came from to the agent that ran it, so an
 * issue can keep one reachable session per agent.
 */
/** Adds the per-agent sessions only when an issue actually has some. */
function withAgentSessions(database, task) {
  const agentSessions = database.listAgentSessions(task.id);
  return agentSessions.length > 0 ? { ...task, agentSessions } : task;
}

function rememberAgentSession(database, request, taskId, sessionId) {
  if (!taskId || !sessionId) return;
  const agent = agentByActorId(actorFromRequest(request).id);
  if (agent) database.recordAgentSession(taskId, agent.kind, sessionId);
}

/**
 * `tasks.thread_id` predates multi-agent support and every reader — the Codex
 * host bridge and the cloud board, which has no per-agent sessions table —
 * treats it as a Codex thread. So only Codex may stamp it; every other agent is
 * reachable through `task_agent_sessions` instead.
 */
function codexOnlyThreadId(request, threadId) {
  if (threadId === undefined) return undefined;
  const agent = agentByActorId(actorFromRequest(request).id);
  return !agent || agent.kind === "codex" ? threadId : undefined;
}

function parseAssigneeTarget(value) {
  if (value === undefined) return undefined;
  if (!isAssigneeTarget(value)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      `'assigneeTarget' must be one of ${ASSIGNEE_TARGETS.join(", ")}`,
    );
  }
  return value;
}

/** 只读探测不该让界面无限等；超时抛出可读原因而不是挂着。 */
function withDeadline(work, timeoutMs, message) {
  return Promise.race([
    work,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new ApiError(504, "SKILL_STATUS_TIMEOUT", message)), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

function resolveAssignee(target, actor) {
  if (target === undefined) return actor;
  const agent = agentByAssigneeTarget(target);
  if (agent) return agent.actor;
  if (actor.type !== "user") {
    throw new ApiError(400, "INVALID_FIELD", "'current-user' requires a user request identity");
  }
  return actor;
}

function parseWorkflowId(value) {
  const workflowId = stringField(value, "workflowId", { nullable: true, maxLength: 128 });
  if (workflowId === "") {
    throw new ApiError(400, "INVALID_FIELD", "'workflowId' cannot be empty");
  }
  return workflowId;
}

function parseTaskCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId", "title", "description", "status", "priority", "labels", "sortOrder", "threadId",
    "assigneeTarget", "workflowId", "developmentContext", "dueDate", "recurrence",
  ]));
  const projectId = validateProjectId(body.projectId, { field: "projectId" });
  const task = {
    projectId,
    title: stringField(body.title, "title", { required: true, maxLength: 240 }),
    description: stringField(body.description ?? "", "description", { maxLength: 100_000 }),
    status: parseStatus(body.status, "backlog"),
    priority: parsePriority(body.priority, "none"),
    labels: body.labels === undefined ? [] : parseLabels(body.labels),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    assigneeTarget: parseAssigneeTarget(body.assigneeTarget),
    workflowId: parseWorkflowId(body.workflowId ?? null),
    developmentContext: parseDevelopmentContext(body.developmentContext ?? null),
    dueDate: parseDueDate(body.dueDate ?? null),
    recurrence: parseRecurrence(body.recurrence ?? null),
  };
  if (task.recurrence && !task.dueDate) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring task requires 'dueDate'");
  }
  return task;
}

function parseTaskPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "version", "title", "description", "status", "priority", "labels", "threadId",
    "assigneeTarget", "workflowId", "developmentContext", "dueDate", "recurrence",
  ]));
  const version = parseVersion(body.version);
  const threadId = parseThreadId(body.threadId);
  const assigneeTarget = parseAssigneeTarget(body.assigneeTarget);
  const changes = {};
  if (body.title !== undefined) changes.title = stringField(body.title, "title", { required: true, maxLength: 240 });
  if (body.description !== undefined) changes.description = stringField(body.description, "description", { maxLength: 100_000 });
  if (body.status !== undefined) changes.status = parseStatus(body.status);
  if (body.priority !== undefined) changes.priority = parsePriority(body.priority);
  if (body.labels !== undefined) changes.labels = parseLabels(body.labels);
  if (body.workflowId !== undefined) changes.workflowId = parseWorkflowId(body.workflowId);
  if (body.developmentContext !== undefined) changes.developmentContext = parseDevelopmentContext(body.developmentContext);
  if (body.dueDate !== undefined) changes.dueDate = parseDueDate(body.dueDate);
  if (body.recurrence !== undefined) changes.recurrence = parseRecurrence(body.recurrence);
  if (changes.recurrence && body.dueDate === null) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring task requires 'dueDate'");
  }
  if (Object.keys(changes).length === 0 && assigneeTarget === undefined) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one task field");
  }
  return { version, changes, threadId, assigneeTarget };
}

function parseMove(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "status", "sortOrder", "threadId"]));
  return {
    version: parseVersion(body.version),
    status: parseStatus(body.status),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
  };
}

function parseArchive(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "threadId"]));
  return { version: parseVersion(body.version), threadId: parseThreadId(body.threadId) };
}

function parseIssueRelationType(value) {
  if (!["parent", "blocks", "blocked_by", "related"].includes(value)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'relation type' must be parent, blocks, blocked_by, or related",
    );
  }
  return value;
}

function parseCommentCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["body", "threadId"]));
  return {
    body: stringField(body.body ?? "", "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
  };
}

function parseCommentPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "body", "threadId"]));
  if (body.body === undefined) {
    throw new ApiError(400, "INVALID_FIELD", "'body' is required");
  }
  return {
    version: parseVersion(body.version),
    body: stringField(body.body, "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
  };
}

function parseAttachmentHeaders(request) {
  const encodedFilename = request.headers["x-taskboard-filename"];
  if (typeof encodedFilename !== "string") {
    throw new ApiError(400, "INVALID_FILENAME", "X-Taskboard-Filename is required");
  }
  let filename;
  try {
    filename = decodeURIComponent(encodedFilename).trim();
  } catch {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename contains invalid encoding");
  }
  if (
    filename.length === 0
    || filename.length > 240
    || filename === "."
    || filename === ".."
    || /[\u0000-\u001f\u007f/\\]/.test(filename)
  ) {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename is invalid");
  }

  const rawContentType = request.headers["content-type"];
  const contentType = typeof rawContentType === "string"
    ? rawContentType.split(";", 1)[0].trim().toLowerCase()
    : "application/octet-stream";
  if (contentType.length === 0 || contentType.length > 200 || !/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(contentType)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Attachment Content-Type is invalid");
  }
  return { filename, contentType };
}

async function readBody(request, limit, tooLargeMessage) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(
  request,
  limit = JSON_BODY_LIMIT,
  tooLargeMessage = "Request body cannot exceed 1 MiB",
) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const body = await readBody(request, limit, tooLargeMessage);
  const length = body.length;
  if (length === 0) {
    throw new ApiError(400, "INVALID_JSON", "Request body cannot be empty");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must contain valid JSON");
  }
}

async function assertEmptyRequestBody(request, routeLabel) {
  const body = await readBody(request, JSON_BODY_LIMIT, "Request body cannot exceed 1 MiB");
  if (body.length > 0) {
    throw new ApiError(400, "INVALID_BODY", `${routeLabel} does not accept a request body`);
  }
}

function parseTaskFilters(searchParams) {
  const allowed = new Set(["projectId", "status", "archived"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }

  const projectIdValue = searchParams.get("projectId");
  const statusValue = searchParams.get("status");
  const archived = searchParams.get("archived") ?? "false";
  if (statusValue !== null && !isTaskStatus(statusValue)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "Invalid task status");
  }
  if (!new Set(["true", "false", "all"]).has(archived)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "'archived' must be true, false, or all");
  }
  const projectId = projectIdValue === null ? undefined : validateProjectId(projectIdValue);
  return { projectId, status: statusValue ?? undefined, archived };
}

function parseAiSetting(value, name, maxLength) {
  const setting = stringField(value, name, { maxLength });
  if (setting === "") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  return setting;
}

function parseAiThreadCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId",
    "issueId",
    "title",
    "agentKind",
    "model",
    "reasoningEffort",
  ]));
  return {
    projectId: validateProjectId(body.projectId),
    issueId: parseAiSetting(body.issueId, "issueId", 128),
    title: parseAiSetting(body.title, "title", 160),
    agentKind: parseAiSetting(body.agentKind, "agentKind", 32),
    model: parseAiSetting(body.model, "model", 128),
    reasoningEffort: parseAiSetting(body.reasoningEffort, "reasoningEffort", 64),
  };
}

function parseAiThreadPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["title", "model", "reasoningEffort"]));
  const input = {};
  if (body.title !== undefined) input.title = parseAiSetting(body.title, "title", 160);
  if (body.model !== undefined) input.model = parseAiSetting(body.model, "model", 128);
  if (body.reasoningEffort !== undefined) {
    input.reasoningEffort = parseAiSetting(body.reasoningEffort, "reasoningEffort", 64);
  }
  if (Object.keys(input).length === 0) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one thread setting");
  }
  return input;
}

function parseAiSkillIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'skillIds' must be an array with at most 20 entries");
  }
  const skillIds = value.map((skillId, index) => (
    stringField(skillId, `skillIds[${index}]`, { required: true, maxLength: 256 })
  ));
  return skillIds;
}

function parseAiAttachments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > AI_CHAT_ATTACHMENT_LIMIT) {
    throw new ApiError(
      400,
      "INVALID_ATTACHMENT",
      `'attachments' must be an array with at most ${AI_CHAT_ATTACHMENT_LIMIT} files`,
    );
  }
  return value.map((attachment, index) => {
    assertPlainObject(attachment);
    assertAllowedKeys(attachment, new Set(["filename", "contentType", "dataBase64"]));
    const filename = stringField(attachment.filename, `attachments[${index}].filename`, {
      required: true,
      maxLength: 240,
    });
    if (/[\u0000-\u001f\u007f/\\]/.test(filename)) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].filename' is invalid`,
      );
    }
    const contentType = stringField(
      attachment.contentType,
      `attachments[${index}].contentType`,
      { required: true, maxLength: 256 },
    ).toLowerCase();
    const dataBase64 = stringField(
      attachment.dataBase64,
      `attachments[${index}].dataBase64`,
      { required: true, maxLength: AI_CHAT_TURN_BODY_LIMIT },
    );
    if (
      dataBase64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)
    ) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].dataBase64' must contain valid base64`,
      );
    }
    const data = Buffer.from(dataBase64, "base64");
    if (data.length === 0 || data.toString("base64") !== dataBase64) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].dataBase64' must contain valid base64`,
      );
    }
    return { filename, contentType, data, size: data.length };
  });
}

function parseAiTurn(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "message",
    "skillIds",
    "dangerFullAccessConfirmed",
    "attachments",
  ]));
  if (
    body.dangerFullAccessConfirmed !== undefined
    && typeof body.dangerFullAccessConfirmed !== "boolean"
  ) {
    throw new ApiError(400, "INVALID_FIELD", "'dangerFullAccessConfirmed' must be a boolean");
  }
  const message = stringField(body.message ?? "", "message", { maxLength: 100_000 });
  const skillIds = parseAiSkillIds(body.skillIds) ?? [];
  if (message.split(AI_CHAT_SKILL_MARKER).length - 1 !== skillIds.length) {
    throw new ApiError(400, "INVALID_FIELD", "'skillIds' must match the Skill markers in 'message'");
  }
  const attachments = parseAiAttachments(body.attachments);
  if (message === "" && attachments.length === 0) {
    throw new ApiError(
      400,
      "INVALID_MESSAGE",
      "A message or at least one attachment is required",
    );
  }
  return {
    message,
    skillIds,
    dangerFullAccessConfirmed: body.dangerFullAccessConfirmed,
    attachments,
  };
}

class EventHub {
  constructor() {
    this.clients = new Set();
    this.keepAlive = setInterval(() => {
      for (const response of this.clients) response.write(": keep-alive\n\n");
    }, 20_000);
    this.keepAlive.unref();
  }

  connect(request, response) {
    response.writeHead(200, {
      connection: "keep-alive",
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");
    this.clients.add(response);
    request.once("close", () => this.clients.delete(response));
  }

  emit(type, value) {
    const event = {
      type,
      projectId: value.projectId ?? value.project?.id ?? value.task?.projectId,
      taskId: value.task?.id ?? value.comment?.taskId ?? value.attachment?.taskId,
      ...value,
      at: new Date().toISOString(),
    };
    const message = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const response of this.clients) response.write(message);
  }

  close() {
    clearInterval(this.keepAlive);
    for (const response of this.clients) response.end();
    this.clients.clear();
  }
}

async function serveStatic(request, response, pathname, staticDirectory) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new ApiError(400, "INVALID_PATH", "URL path contains invalid encoding");
  }
  if (decodedPath.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", "URL path is invalid");
  }

  const root = path.resolve(staticDirectory);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  let filename = path.resolve(root, relativePath);
  if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) {
    throw new ApiError(400, "INVALID_PATH", "URL path is outside the static directory");
  }

  let fileStats;
  try {
    fileStats = await stat(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!fileStats?.isFile() && !path.extname(relativePath)) {
    filename = path.join(root, "index.html");
    try {
      fileStats = await stat(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!fileStats?.isFile()) return false;

  const body = await readFile(filename);
  const headers = {
    "cache-control": path.basename(filename) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    "content-length": body.length,
    "content-type": CONTENT_TYPES.get(path.extname(filename).toLowerCase()) ?? "application/octet-stream",
  };
  response.writeHead(200, headers);
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}

function methodNotAllowed(response, allowed) {
  sendJson(response, 405, {
    error: { code: "METHOD_NOT_ALLOWED", message: `Allowed methods: ${allowed.join(", ")}` },
  }, { allow: allowed.join(", ") });
}

function codexProjectRoot(state, projectId) {
  if (!projectId || !state || typeof state !== "object") return null;
  const project = state["local-projects"]?.[projectId];
  const root = Array.isArray(project?.rootPaths) ? project.rootPaths[0] : null;
  return typeof root === "string" && root.trim() ? root : null;
}

function latestThreadCwd(value, threadId) {
  const matches = [];
  const stack = [value];
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate.conversationId === threadId && typeof candidate.cwd === "string" && candidate.cwd.trim()) {
      matches.push(candidate);
    }
    stack.push(...(Array.isArray(candidate) ? candidate : Object.values(candidate)));
  }
  matches.sort((left, right) => Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0));
  return matches[0]?.cwd ?? null;
}

async function resolveProjectWorkspace(project, codexProjectId, codexThreadId, codexStatePath, codexProcessesPath) {
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    const assignment = state["thread-project-assignments"]?.[codexThreadId];
    const root = codexProjectRoot(state, project.id)
      ?? codexProjectRoot(state, codexProjectId)
      ?? codexProjectRoot(state, assignment?.projectId)
      ?? (typeof assignment?.cwd === "string" ? assignment.cwd : null);
    if (root) return root;
  } catch {}
  if (project.workspacePath) return project.workspacePath;
  if (!codexThreadId) return null;
  try {
    const processes = JSON.parse(await readFile(codexProcessesPath, "utf8"));
    return latestThreadCwd(processes, codexThreadId);
  } catch {
    return null;
  }
}

function parseWorktrees(output) {
  const contexts = [];
  for (const block of output.trim().split(/\n\s*\n/)) {
    if (!block) continue;
    let worktreePath = "";
    let branch = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) worktreePath = line.slice(9);
      if (line.startsWith("branch refs/heads/")) branch = line.slice(18);
    }
    if (worktreePath) contexts.push({ type: "worktree", path: worktreePath, branch });
  }
  return contexts;
}

async function scanDevelopmentContexts(workspacePath) {
  if (!workspacePath) return { workspacePath: null, contexts: [] };
  try {
    const rootResult = await execFileAsync("git", ["-C", workspacePath, "rev-parse", "--show-toplevel"], {
      timeout: 4_000,
      maxBuffer: 1024 * 1024,
    });
    const root = rootResult.stdout.trim();
    const [branchesResult, worktreesResult] = await Promise.all([
      execFileAsync("git", ["-C", root, "for-each-ref", "--format=%(refname:short)", "refs/heads"], {
        timeout: 4_000,
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"], {
        timeout: 4_000,
        maxBuffer: 1024 * 1024,
      }),
    ]);
    const branches = branchesResult.stdout.split("\n").map((branch) => branch.trim()).filter(Boolean);
    return {
      workspacePath: root,
      contexts: [
        ...branches.map((branch) => ({ type: "branch", branch })),
        ...parseWorktrees(worktreesResult.stdout),
      ],
    };
  } catch {
    return { workspacePath, contexts: [] };
  }
}

async function discoverSkills(codexExecutable, workspacePath) {
  const entries = await new Promise((resolve, reject) => {
    const child = spawn(codexExecutable, ["app-server", "--stdio"], {
      cwd: workspacePath,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let buffer = "";
    const timeout = setTimeout(() => {
      finish(new Error("Timed out while reading Codex skills"));
    }, 10_000);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function handleMessage(message) {
      if (message?.id === 1) {
        if (message.error) {
          finish(new Error("Codex app-server rejected initialization"));
          return;
        }
        send({ method: "initialized" });
        send({
          id: 2,
          method: "skills/list",
          params: { cwds: [workspacePath], forceReload: false },
        });
        return;
      }
      if (message?.id !== 2) return;
      if (message.error) {
        finish(new Error("Codex app-server could not list skills"));
        return;
      }
      finish(null, Array.isArray(message.result?.data) ? message.result.data : []);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch {}
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(`Codex app-server exited before listing skills (${signal || code})`));
      }
    });
    child.once("spawn", () => {
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "agent-taskboard", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
      });
    });
  });

  const unique = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry?.skills)) continue;
    for (const skill of entry.skills) {
      if (
        !skill
        || typeof skill !== "object"
        || skill.enabled === false
        || typeof skill.name !== "string"
        || !skill.name.trim()
      ) {
        continue;
      }
      const id = skill.name.trim();
      if (unique.has(id)) continue;
      const displayName = typeof skill.interface?.displayName === "string"
        ? skill.interface.displayName.trim()
        : "";
      unique.set(id, {
        id,
        label: displayName || id,
        description: typeof skill.description === "string" ? skill.description.trim() : "",
        path: typeof skill.path === "string" ? skill.path.trim() : "",
        scope: ["user", "repo", "system", "admin"].includes(skill.scope)
          ? skill.scope
          : "user",
      });
    }
  }
  return [...unique.values()].sort((left, right) => left.label.localeCompare(right.label));
}

async function discoverMcpServers(codexExecutable) {
  const result = await execFileAsync(codexExecutable, ["mcp", "list", "--json"], {
    timeout: 8_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const entries = JSON.parse(result.stdout);
  if (!Array.isArray(entries)) throw new Error("Codex returned an invalid MCP server list");
  return entries
    .filter((entry) => (
      entry
      && typeof entry === "object"
      && typeof entry.name === "string"
      && entry.name.trim()
      && entry.enabled !== false
    ))
    .map((entry) => ({
      id: entry.name.trim(),
      label: entry.name.trim(),
      transport: typeof entry.transport?.type === "string"
        ? entry.transport.type
        : "unknown",
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

async function discoverWorkflowCapabilities(resolved, workspacePath) {
  const [skills, mcpServers] = await Promise.all([
    discoverSkills(resolved.codexExecutable, workspacePath),
    discoverMcpServers(resolved.codexExecutable),
  ]);
  return { skills, mcpServers };
}

export function resolveServerOptions(options = {}) {
  const configuredDataDirectory = options.dataDirectory ?? process.env.CODEX_TASKBOARD_DATA_DIR;
  const dataDirectory = configuredDataDirectory
    ? path.resolve(configuredDataDirectory)
    : path.join(PROJECT_ROOT, ".data");
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return {
    // profile 只有安装版才有；开发版为 null，服务端不接受请求参数切换它。
    profile: options.profile ?? null,
    appVersion: options.appVersion ?? APP_VERSION_FULL,
    dataDirectory,
    databasePath: options.databasePath ?? path.join(dataDirectory, "taskboard.sqlite"),
    attachmentsDirectory: options.attachmentsDirectory ?? path.join(dataDirectory, "attachments"),
    // 当前启动的易失状态，一期只有 Codex CDP 端口。
    runtimeDirectory: options.runtimeDirectory ?? path.join(dataDirectory, "runtime"),
    cloudConfigPath: options.cloudConfigPath ?? path.join(dataDirectory, "cloud-companion.json"),
    staticDirectory: options.staticDirectory ?? path.join(PROJECT_ROOT, "dist", "web"),
    skillPath: options.skillPath ?? path.join(PROJECT_ROOT, "skills", "manage-taskboard", "SKILL.md"),
    // 安装版由 --taskctl-cli-path 指到 Resources/cli；PROJECT_ROOT 只服务于开发和测试。
    taskctlCliPath: options.taskctlCliPath ?? path.join(PROJECT_ROOT, "cli", "taskctl.mjs"),
    codexExecutable: options.codexExecutable ?? process.env.CODEX_EXECUTABLE ?? "codex",
    codexStatePath: options.codexStatePath
      ?? path.join(codexHome, ".codex-global-state.json"),
    codexProcessesPath: options.codexProcessesPath
      ?? path.join(codexHome, "process_manager", "chat_processes.json"),
    claudeExecutable: options.claudeExecutable ?? process.env.CLAUDE_EXECUTABLE ?? "claude",
    claudeHome: options.claudeHome
      ?? process.env.CLAUDE_CONFIG_DIR
      ?? path.join(os.homedir(), ".claude"),
  };
}

export function resolvePort(value = process.env.CODEX_TASKBOARD_PORT ?? "47823") {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CODEX_TASKBOARD_PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function resolveHost(value = process.env.CODEX_TASKBOARD_HOST ?? "0.0.0.0") {
  const host = String(value).trim();
  if (host !== "127.0.0.1" && host !== "0.0.0.0") {
    throw new Error("CODEX_TASKBOARD_HOST must be 127.0.0.1 or 0.0.0.0");
  }
  return host;
}

export function createTaskboardServer(options = {}) {
  const resolved = resolveServerOptions(options);
  // 每次启动一个新的 instanceId，壳靠它区分「重连到同一个 sidecar」和「换了一个进程」。
  const instanceId = randomUUID();
  const database = new TaskboardDatabase(resolved.databasePath);
  const events = new EventHub();
  const cloudConfig = options.cloudConfigStore ?? createCloudConfigStore({
    configPath: resolved.cloudConfigPath,
  });
  const cloudProxy = createCloudProxy({
    configStore: cloudConfig,
    fetch: options.remoteFetch ?? globalThis.fetch,
    resolveDevelopmentContext: async (projectId, context) => {
      if (!context.branch) return null;
      const config = await cloudConfig.read();
      const workspacePath = config.projectMappings[projectId];
      if (!workspacePath) return null;
      const result = await scanDevelopmentContexts(workspacePath);
      return result.contexts.find((candidate) => (
        candidate.type === "worktree" && candidate.branch === context.branch
      )) ?? null;
    },
  });
  const deviceWorkspaces = createDeviceWorkspaces({
    codexStatePath: resolved.codexStatePath,
    database,
    readProjectMappings: async () => (await cloudConfig.read()).projectMappings,
  });
  const agents = createAgentRegistry({
    codex: {
      inspectDesktop: () => codexDesktopController.inspect(),
      executable: resolved.codexExecutable,
      statePath: resolved.codexStatePath,
      skillPath: resolved.skillPath,
      database,
    },
    claude: {
      executable: resolved.claudeExecutable,
      claudeHome: resolved.claudeHome,
      database,
      deviceWorkspaces,
    },
    workbuddy: {
      debuggingPort: options.workbuddyDebuggingPort,
      desktopController: options.workbuddyDesktopController,
      // origin 要等 listen() 之后才知道，所以惰性求值。
      verifyBoardMcp: () => verifyMcpEndpoint(`${taskctlRuntime.currentOrigin()}/mcp`),
    },
  });
  const taskctlRuntime = createTaskctlRuntime({
    binDirectory: path.join(resolved.dataDirectory, "bin"),
    cliPath: resolved.taskctlCliPath,
  });
  const agentRuntimeStatuses = options.agentRuntimeStatuses
    ?? createAgentRuntimeStatuses({ registry: agents });

  /**
   * 保存任务前只快速校验这一个负责人对应的 Agent（§6）。只有拿到「新鲜且明确不可用」
   * 的结论才拦；超时沿用旧状态、`unknown` 和「自己」都直接放行，探测问题不阻塞保存。
   */
  async function assertAssignableAgent(assigneeTarget) {
    const agent = assigneeTarget ? agentByAssigneeTarget(assigneeTarget) : null;
    if (!agent) return;
    const runtime = await agentRuntimeStatuses.forInteraction(agent.kind);
    if (runtime.status === "ready" || runtime.status === "unknown" || runtime.stale) return;
    throw new ApiError(
      409,
      "AGENT_NOT_READY",
      runtime.statusMessage || `${agent.label} 当前不可用，无法分配任务`,
      { agentKind: agent.kind, runtime },
    );
  }
  const aiChat = new AiChatService({
    database,
    agents,
    manageTaskboardSkillPath: resolved.skillPath,
    taskctlRuntime,
    onIssueSession: ({ issueId }) => {
      const task = database.getTask(issueId);
      if (task) events.emit("task.updated", { task });
    },
  });
  const aiEventResponses = new Set();
  const codexDefinition = agentByKind("codex");
  const codexDesktopController = options.codexDesktopController
    ?? createCodexDesktopController({ preferredPort: options.codexDebuggingPort });

  function requestHeadersForCloud(request) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
      else if (value !== undefined) headers.set(name, value);
    }
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    return headers;
  }

  async function cloudJson(request, pathname, method = "GET", body = undefined) {
    const headers = requestHeadersForCloud(request);
    const init = { method, headers };
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(body);
    }
    const upstream = await cloudProxy.forward(new Request(`http://127.0.0.1${pathname}`, init));
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      throw new CloudProxyError(
        upstream.status,
        payload.error?.code ?? "REMOTE_ERROR",
        payload.error?.message ?? "Cloud taskboard request failed",
        payload.error?.details,
      );
    }
    return payload;
  }

  /** Shared by every launcher: cloud tasks come from the proxy, local from SQLite. */
  const loadTaskForLaunch = async (taskId, input) => {
    if (input.cloud) {
      return (await cloudJson(
        input.sourceRequest,
        `/api/tasks/${encodeURIComponent(taskId)}`,
      )).task;
    }
    return withAgentSessions(database, database.getTask(taskId));
  };

  const bindSessionForLaunch = async (binding, input) => {
    if (input.cloud) {
      const { taskId, ...payload } = binding;
      return (await cloudJson(
        input.sourceRequest,
        `/api/tasks/${encodeURIComponent(taskId)}/agent-sessions`,
        "POST",
        payload,
      )).task;
    }
    const task = database.bindAgentSession(
      binding.taskId,
      binding.agentKind,
      binding.sessionId,
      binding.previousSessionId,
    );
    const decorated = withAgentSessions(database, task);
    events.emit("task.updated", { task: decorated });
    return decorated;
  };

  /**
   * Where a task's work happens on this device. Every client that can be told
   * to open a folder gets the same answer, whether it calls it a project, a
   * workspace root or a 工作空间.
   */
  const resolveTaskWorkspace = async (task) => {
    if (task.developmentContext?.type === "worktree" && task.developmentContext.path) {
      try {
        if ((await stat(task.developmentContext.path)).isDirectory()) {
          return path.resolve(task.developmentContext.path);
        }
      } catch {}
    }
    return (await deviceWorkspaces()).get(task.projectId) ?? null;
  };

  const codexTaskLauncher = createCodexTaskLaunchCoordinator({
    desktopController: codexDesktopController,
    skillPath: resolved.skillPath,
    codexActorId: codexDefinition.actor.id,
    // 同一目录被多个项目引用时收敛到同一个 Codex 项目（§9、§12）。
    resolveCodexProjectId: async (task, workspacePath) => {
      if (!workspacePath) return task.projectId;
      const index = await deviceWorkspaces.byWorkspaceKey().catch(() => null);
      const entry = index?.get(workspaceKey(workspacePath));
      // 取索引里第一个项目 id 作为该目录的代表，保证同目录始终落在同一个 Codex 项目。
      return entry?.projectIds[0] ?? task.projectId;
    },
    resolveTaskctlShim: () => taskctlRuntime.shimPath(),
    loadTask: loadTaskForLaunch,
    resolveWorkspace: resolveTaskWorkspace,
    bindSession: bindSessionForLaunch,
  });

  const workbuddyAgent = agents.get("workbuddy");
  const workbuddyTaskLauncher = createWorkbuddyTaskLaunchCoordinator({
    desktopController: workbuddyAgent.desktopController,
    // `skillPath` names SKILL.md; WorkBuddy installs the whole skill directory.
    skillPath: path.dirname(resolved.skillPath),
    // The board's own address, which WorkBuddy keeps in its MCP config and
    // never sees inside a conversation. Read at launch time so it matches the
    // port the server actually bound to.
    boardOrigin: () => boardOrigin(),
    loadTask: loadTaskForLaunch,
    resolveWorkspace: resolveTaskWorkspace,
    bindSession: bindSessionForLaunch,
  });

  /** One service per author identity; writes are attributed to the agent. */
  const mcpService = createMcpService({
    database,
    actor: workbuddyAgent.actor,
  });


  /** Launchers for agents the board wakes inside their own client. */
  const hostTaskLaunchers = new Map([["workbuddy", workbuddyTaskLauncher]]);

  // 启动所有权收敛在这里：任务写入完成后由它统一选 transport 并执行（§8）。
  const launchCoordinator = createAgentLaunchCoordinator({
    registry: agents,
    runtimeStatuses: agentRuntimeStatuses,
    runHeadless: async ({ agentKind, task }) => {
      const thread = await aiChat.createThread({
        projectId: task.projectId,
        issueId: task.id,
        agentKind,
      });
      const run = await aiChat.startTurn(thread.id, {
        message: `执行任务 ${task.identifier}。`,
      });
      return { status: "started", threadId: thread.id, runId: run.id };
    },
    runNative: ({ task, expectedVersion, trigger, presentation, previousSessionId, transport, sourceRequest, cloud }) => (
      codexTaskLauncher.launch({
        taskId: task.id,
        expectedVersion: expectedVersion ?? task.version,
        trigger,
        // native-draft 只预填不发送，native-submit 提交并捕获 canonical session ID。
        presentation: transport === "native-draft" ? "foreground" : presentation,
        previousSessionId,
        cloud: Boolean(cloud),
        sourceRequest,
      })
    ),
    runHost: ({ agentKind, task, expectedVersion, trigger, presentation, previousSessionId, sourceRequest }) => {
      const launcher = hostTaskLaunchers.get(agentKind);
      if (!launcher) throw new Error(`${agentKind} has no host launcher`);
      return launcher.launch({
        taskId: task.id,
        expectedVersion: expectedVersion ?? task.version,
        trigger,
        presentation,
        previousSessionId,
        cloud: false,
        sourceRequest,
      });
    },
  });

  /**
   * 状态迁移触发的自动启动。前端只提交一次业务请求，不再为任何 Agent
   * 发起第二次启动调用。
   */
  async function startAssignedAgentOnTransition(request, previous, task) {
    const enteredInProgress = previous.status !== "in_progress" && task.status === "in_progress";
    const assignedAgentInProgress = previous.status === "in_progress"
      && task.status === "in_progress"
      && previous.assignee.id !== task.assignee.id;
    if (
      actorFromRequest(request).type !== "user"
      || (!enteredInProgress && !assignedAgentInProgress)
      || task.assignee.type !== "agent"
    ) {
      return null;
    }
    return launchCoordinator.launch({
      task,
      expectedVersion: task.version,
      taskId: task.id,
      trigger: "status-transition",
      presentation: "background",
      previousSessionId: null,
      sourceRequest: request,
      // 云端模式下 /api/tasks/* 由代理转发，这条路径只会在本地任务上跑到。
      cloud: false,
    });
  }

  /** Where an agent client should reach this board, once it is listening. */
  function boardOrigin() {
    const address = server.address();
    const port = address && typeof address === "object" && address.port
      ? address.port
      : Number(process.env.CODEX_TASKBOARD_PORT ?? 47823);
    return `http://127.0.0.1:${port}`;
  }

  const server = createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    try {
      assertTrustedNetworkRequest(request);
      const url = new URL(request.url, "http://127.0.0.1");
      const pathname = url.pathname;
      // The MCP endpoint is how host-launch agents read and write the board.
      // It stays outside `/api` because clients are configured with a bare
      // `<origin>/mcp` URL, and it is loopback-only: any local process posting
      // here writes as the agent identity.
      if (pathname === "/mcp") {
        assertLoopbackRequest(request);
        assertNoQuery(url.searchParams, "MCP endpoint");
        const bodyText = request.method === "POST"
          ? (await readBody(request, JSON_BODY_LIMIT, "MCP request body cannot exceed 1 MiB"))
            .toString("utf8")
          : "";
        const reply = await mcpService.handleHttp({
          method: request.method,
          accept: requestHeader(request, "accept") ?? "",
          bodyText,
        });
        response.writeHead(reply.status, reply.headers);
        return response.end(reply.body);
      }

      const isLocalAiRoute = pathname === "/api/local/ai" || pathname.startsWith("/api/local/ai/");
      if (isLocalAiRoute) {
        assertAiLoopbackRequest(request);
      } else if (pathname.startsWith("/api/local/")) {
        assertLoopbackRequest(request);
      }
      const isMachineCapabilityRoute = pathname === "/api/meta"
        || pathname === "/api/device-workspaces"
        || pathname === "/api/workflow-capabilities"
        || /^\/api\/projects\/[^/]+\/development-contexts$/.test(pathname);
      const capabilityCloudConfig = isMachineCapabilityRoute
        ? await cloudConfig.read()
        : null;
      if (capabilityCloudConfig?.remoteUrl) assertLoopbackRequest(request);

      if (pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        // 身份用于端口占用判定：壳只有确认 appId、profile 和版本都匹配才加载主窗口，
        // 否则宁可报端口冲突也不误连。版本只来自编译期常量，不读 Info.plist。
        return sendJson(response, 200, {
          status: "ok",
          appId: APP_ID,
          profile: resolved.profile ?? PROFILE_DEVELOPMENT,
          version: APP_VERSION_FULL,
          pid: process.pid,
          instanceId,
        });
      }

      if (pathname === "/api/local/cloud-session") {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Cloud session routes do not accept query parameters");
        }
        if (request.method === "GET") {
          const config = await cloudConfig.read();
          return sendJson(response, 200, config.remoteUrl
            ? {
              mode: "cloud",
              remoteUrl: config.remoteUrl,
              actorName: config.actorName,
              authenticated: true,
            }
            : { mode: "local", authenticated: false });
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["remoteUrl", "actorName", "sharedKey"]));
          try {
            const config = await cloudConfig.configure({
              remoteUrl: body.remoteUrl,
              actorName: body.actorName,
              sharedKey: body.sharedKey,
            });
            return sendJson(response, 200, {
              mode: "cloud",
              remoteUrl: config.remoteUrl,
              actorName: config.actorName,
              authenticated: true,
            });
          } catch (error) {
            throw new ApiError(400, error.code ?? "INVALID_CLOUD_CONFIG", error.message);
          }
        }
        if (request.method === "DELETE") {
          await cloudConfig.clearCloud();
          return sendJson(response, 200, { mode: "local", authenticated: false });
        }
        return methodNotAllowed(response, ["GET", "PUT", "DELETE"]);
      }

      const projectMappingRoute = pathname.match(/^\/api\/local\/project-mappings\/([^/]+)$/);
      if (projectMappingRoute) {
        if (request.method !== "PUT") return methodNotAllowed(response, ["PUT"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project mapping routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectMappingRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["workspacePath"]));
        const workspacePath = pathField(body.workspacePath, "workspacePath");
        if (!workspacePath || !path.isAbsolute(workspacePath)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be absolute");
        }
        await cloudConfig.setProjectWorkspace(projectId, workspacePath);
        return sendJson(response, 200, { projectId, workspacePath });
      }

      // Creating a project means naming a folder, so this route owns the folder
      // dialog too. `workspacePath` skips it, which is how a shell with a picker
      // of its own — or a test — supplies the answer directly.
      if (pathname === "/api/local/projects") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertLoopbackRequest(request);
        assertNoQuery(url.searchParams, "POST /api/local/projects");
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["workspacePath"]));

        let workspacePath;
        if (body.workspacePath === undefined) {
          ({ workspacePath } = await chooseDirectory());
        } else {
          const requested = pathField(body.workspacePath, "workspacePath");
          if (!requested || !path.isAbsolute(requested)) {
            throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be absolute");
          }
          workspacePath = await existingDirectory(requested);
          if (!workspacePath) {
            throw new ApiError(404, "WORKSPACE_NOT_FOUND", `'${requested}' is not a directory on this device`);
          }
        }

        // A folder identifies a project, so picking one that some agent already
        // works in reopens that project instead of splitting it in two. Codex
        // knows folders the board has never stored, and those become the board's
        // project under Codex's own id, which is what keeps the two sides paired.
        const workspaces = await deviceWorkspaces();
        for (const [projectId, candidate] of workspaces) {
          if (candidate !== workspacePath) continue;
          const stored = database.getProject(projectId);
          if (stored) return sendJson(response, 200, { project: stored, created: false });
          const adopted = database.createProject({
            id: projectId,
            name: path.basename(workspacePath),
            workspacePath,
          });
          events.emit("project.created", { project: adopted });
          return sendJson(response, 201, { project: adopted, created: true });
        }

        const taken = new Set(database.listProjects().map((project) => project.id));
        const project = database.createProject({
          id: projectIdForDirectory(workspacePath, taken),
          name: path.basename(workspacePath),
          workspacePath,
        });
        events.emit("project.created", { project });
        return sendJson(response, 201, { project, created: true });
      }

      if (pathname === "/api/meta") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/meta does not accept query parameters");
        }
        const loopback = isLoopbackAddress(request.socket.remoteAddress);
        const [nativeCodexTaskLaunch, workbuddyTaskLaunch] = loopback
          ? await Promise.all([
            codexDesktopController.inspect().then((state) => state.available, () => false),
            workbuddyAgent.desktopController.inspect().then((state) => state.available, () => false),
          ])
          : [false, false];
        return sendJson(response, 200, {
          manageTaskboardSkillPath: resolved.skillPath,
          // External clients opened by deeplink do not inherit the agent PATH
          // that `AiChat#turnEnv` builds, so they need the shim spelled out.
          taskctlShimPath: loopback ? await taskctlRuntime.shimPath() : null,
          capabilities: {
            localAiChat: loopback,
            nativeCodexTaskLaunch,
            workbuddyTaskLaunch,
          },
          ...(capabilityCloudConfig?.remoteUrl
            ? {
              mode: "cloud",
              realtime: { transport: "poll", intervalMs: 2000 },
              localCapabilities: { available: true },
            }
            : {}),
        });
      }

      if (pathname === "/api/local/agents") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertAllowedQuery(url.searchParams, new Set(["refresh"]), "GET /api/local/agents");
        // 静态的名称与图标由 Web 从 shared/agents.mjs 按 kind 合并，这里只回 runtime 状态。
        return sendJson(response, 200, {
          defaultAgentKind: DEFAULT_AGENT_KIND,
          agents: await agentRuntimeStatuses.list({
            force: url.searchParams.get("refresh") === "1",
          }),
        });
      }

      if (pathname === "/api/local/ai/catalog") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertAllowedQuery(
          url.searchParams,
          new Set(["projectId", "agentKind"]),
          "GET /api/local/ai/catalog",
        );
        const projectId = validateProjectId(url.searchParams.get("projectId") ?? undefined);
        const agentKind = url.searchParams.get("agentKind") ?? DEFAULT_AGENT_KIND;
        return sendJson(response, 200, await aiChat.getCatalog(projectId, agentKind));
      }

      // Conversations are reached through the task that owns them, so there is
      // no list to serve — only the thread a task's session points at.
      if (pathname === "/api/local/ai/threads") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "/api/local/ai/threads");
        const thread = await aiChat.createThread(parseAiThreadCreate(await readJson(request)));
        return sendJson(response, 201, { thread });
      }

      const aiThreadEventsRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/events$/);
      if (aiThreadEventsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/ai/threads/:id/events");
        const threadId = decodeRouteSegment(aiThreadEventsRoute[1], "Thread id");
        await aiChat.getThreadSnapshot(threadId);
        response.writeHead(200, {
          connection: "keep-alive",
          "cache-control": "no-cache, no-transform",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
        });
        aiEventResponses.add(response);
        const unsubscribe = aiChat.subscribe(threadId, (event) => {
          const type = event?.type === "ai.run" ? "ai.run" : "ai.event";
          response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        response.write(": connected\n\n");
        response.write('event: ai.event\ndata: {"type":"ai.event"}\n\n');
        const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
        keepAlive.unref();
        request.once("close", () => {
          clearInterval(keepAlive);
          unsubscribe();
          aiEventResponses.delete(response);
        });
        return;
      }

      const aiThreadTurnRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/turns$/);
      if (aiThreadTurnRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/threads/:id/turns");
        const threadId = decodeRouteSegment(aiThreadTurnRoute[1], "Thread id");
        const run = await aiChat.startTurn(
          threadId,
          parseAiTurn(await readJson(
            request,
            AI_CHAT_TURN_BODY_LIMIT,
            "AI chat turn body cannot exceed 25 MiB",
          )),
        );
        return sendJson(response, 202, { run });
      }

      const aiThreadRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)$/);
      if (aiThreadRoute) {
        assertNoQuery(url.searchParams, "/api/local/ai/threads/:id");
        const threadId = decodeRouteSegment(aiThreadRoute[1], "Thread id");
        if (request.method === "GET") {
          return sendJson(response, 200, await aiChat.getThreadSnapshot(threadId));
        }
        if (request.method === "PATCH") {
          const thread = await aiChat.updateThread(threadId, parseAiThreadPatch(await readJson(request)));
          return sendJson(response, 200, { thread });
        }
        if (request.method === "DELETE") {
          await assertEmptyRequestBody(request, "DELETE /api/local/ai/threads/:id");
          await aiChat.deleteThread(threadId);
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["GET", "PATCH", "DELETE"]);
      }

      const aiInterruptRoute = pathname.match(/^\/api\/local\/ai\/runs\/([^/]+)\/interrupt$/);
      if (aiInterruptRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/runs/:id/interrupt");
        const runId = decodeRouteSegment(aiInterruptRoute[1], "Run id");
        await assertEmptyRequestBody(request, "POST /api/local/ai/runs/:id/interrupt");
        const run = await aiChat.interrupt(runId);
        return sendJson(response, 200, { run });
      }

      if (pathname === "/api/device-workspaces") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/device-workspaces does not accept query parameters");
        }
        // Every source counts, not just Codex's: a project created from a
        // folder carries its own path, and the board would otherwise offer to
        // locate a checkout it already knows.
        return sendJson(response, 200, {
          workspaces: Object.fromEntries(await deviceWorkspaces()),
        });
      }

      if (pathname === "/api/workflow-capabilities") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const unknownQuery = [...url.searchParams.keys()].filter((key) => key !== "workspacePath");
        if (unknownQuery.length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${unknownQuery[0]}`);
        }
        const workspacePath = stringField(
          url.searchParams.get("workspacePath") ?? null,
          "workspacePath",
          { nullable: true, maxLength: 4096 },
        );
        if (workspacePath?.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
        }
        if (workspacePath && !path.isAbsolute(workspacePath)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be absolute");
        }
        return sendJson(
          response,
          200,
          await discoverWorkflowCapabilities(resolved, workspacePath ?? PROJECT_ROOT),
        );
      }

      let currentCloudConfig = null;
      if (pathname.startsWith("/api/")) {
        currentCloudConfig = await cloudConfig.read();
        if (currentCloudConfig.remoteUrl) {
          assertLoopbackRequest(request);
          if (!isLocalCompanionRoute(pathname)) {
            return sendFetchResponse(
              response,
              await cloudProxy.forward(toFetchRequest(request)),
            );
          }
        }
      }

      // 一键配置 WorkBuddy 的 MCP 连接：用户不填任何路径、端口或 URL（§11）。
      if (pathname === "/api/local/workbuddy/configure") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertLoopbackRequest(request);
        assertNoQuery(url.searchParams, "WorkBuddy configure");
        const access = await ensureWorkbuddyBoardAccess({
          origin: taskctlRuntime.currentOrigin(),
          description: "Agent Taskboard",
          profile: resolved.profile ?? undefined,
        });
        return sendJson(response, 200, {
          serverName: access.mcp.serverName,
          url: access.mcp.url,
          configPath: access.mcp.path,
          backupPath: access.mcp.backupPath ?? null,
          changed: access.mcp.changed,
          handshake: access.handshake,
          requiresApproval: access.requiresApproval,
          approvalHint: access.approvalHint,
        });
      }

      // 共享 skill 的现状与本版本模板的差异（§7）。只读：是否应用由用户显式决定。
      if (pathname === "/api/local/skill") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertLoopbackRequest(request);
        assertNoQuery(url.searchParams, "Skill status");
        const skillDirectory = path.dirname(resolved.skillPath);
        const templateDirectory = path.join(PROJECT_ROOT, "skills", "manage-taskboard");
        // 这条只读接口不值得让界面无限等：文件系统探测卡住时如实报超时。
        const [installation, diff] = await withDeadline(
          Promise.all([
            inspectSkillInstallation({ skillDirectory, claudeHome: resolved.claudeHome }),
            diffSkillAgainstTemplate({ skillDirectory, templateDirectory }),
          ]),
          5_000,
          `读取 skill 状态超时（skill=${skillDirectory} template=${templateDirectory}）`,
        );
        return sendJson(response, 200, {
          profile: resolved.profile ?? PROFILE_DEVELOPMENT,
          // 只有 production 能写共享 skill；beta 与开发实例只读（§7）。
          writable: resolved.profile === "production",
          templateVersion: APP_VERSION_FULL,
          ...installation,
          diff,
        });
      }

      // 手动应用新版模板：只有 production 能写，覆盖前先备份（§7）。
      if (pathname === "/api/local/skill/apply") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertLoopbackRequest(request);
        assertNoQuery(url.searchParams, "Skill template apply");
        if (resolved.profile !== "production") {
          throw new ApiError(
            409,
            "SKILL_READ_ONLY",
            "只有 production 实例可以更新共享 skill；当前实例只读",
          );
        }
        const applied = await withDeadline(
          applySkillTemplate({
            profile: resolved.profile,
            skillDirectory: path.dirname(resolved.skillPath),
            templateDirectory: path.join(PROJECT_ROOT, "skills", "manage-taskboard"),
            profileDirectory: resolved.dataDirectory,
            appliedAt: new Date().toISOString(),
          }),
          15_000,
          "写入共享 skill 超时",
        );
        return sendJson(response, 200, applied);
      }

      // UI 不生成 Agent 最终提示词（§10）：deep link 打开草稿时向服务端要正文。
      const taskInstructionRoute = pathname.match(/^\/api\/local\/tasks\/([^/]+)\/instruction$/);
      if (taskInstructionRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertLoopbackRequest(request);
        assertNoQuery(url.searchParams, "Task instruction");
        const taskId = decodeRouteSegment(taskInstructionRoute[1], "Task id");
        const task = database.getTask(taskId);
        if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
        return sendJson(response, 200, {
          instruction: renderClaudeTaskInstruction({
            identifier: task.identifier,
            taskctlShimPath: await taskctlRuntime.shimPath(),
          }),
        });
      }

      const nativeCodexLaunchRoute = pathname.match(/^\/api\/local\/codex\/tasks\/([^/]+)\/launch$/);
      if (nativeCodexLaunchRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertLoopbackRequest(request);
        assertNoQuery(url.searchParams, "Native Codex task launch");
        const taskId = decodeRouteSegment(nativeCodexLaunchRoute[1], "Task id");
        const launch = parseNativeCodexLaunch(await readJson(request));
        // 云端模式下任务不在本地库里，按 launcher 同一条路径取。
        const cloud = Boolean(currentCloudConfig?.remoteUrl);
        const task = await loadTaskForLaunch(taskId, { cloud, sourceRequest: request });
        if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
        let result;
        try {
          // 走同一个协调器：transport 选择、身份校验和幂等去重只有一处实现。
          result = await launchCoordinator.launch({
            task,
            taskId,
            expectedVersion: launch.expectedVersion,
            trigger: launch.trigger,
            presentation: launch.presentation,
            previousSessionId: launch.previousSessionId ?? null,
            sourceRequest: request,
            cloud,
          });
        } catch (error) {
          if (error instanceof ApiError) throw error;
          const detail = error instanceof Error && error.message.trim()
            ? error.message.trim().slice(0, 1_000)
            : "Codex 原生任务启动失败";
          throw new ApiError(502, "CODEX_NATIVE_TASK_LAUNCH_FAILED", detail);
        }
        return sendJson(response, 200, result);
      }

      const workbuddyLaunchRoute = pathname.match(
        /^\/api\/local\/workbuddy\/tasks\/([^/]+)\/launch$/,
      );
      if (workbuddyLaunchRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertLoopbackRequest(request);
        assertNoQuery(url.searchParams, "WorkBuddy task launch");
        const taskId = decodeRouteSegment(workbuddyLaunchRoute[1], "Task id");
        // WorkBuddy always brings its own window forward, so `presentation` is
        // accepted for a uniform client contract but has no effect here.
        const launch = parseNativeCodexLaunch(await readJson(request));
        let result;
        try {
          result = await workbuddyTaskLauncher.launch({
            ...launch,
            taskId,
            cloud: Boolean(currentCloudConfig?.remoteUrl),
            sourceRequest: request,
          });
        } catch (error) {
          if (error instanceof ApiError) throw error;
          const detail = error instanceof Error && error.message.trim()
            ? error.message.trim().slice(0, 1_000)
            : "WorkBuddy 任务启动失败";
          throw new ApiError(502, "WORKBUDDY_TASK_LAUNCH_FAILED", detail);
        }
        return sendJson(response, 200, result);
      }

      const workbuddyOpenRoute = pathname.match(
        /^\/api\/local\/workbuddy\/sessions\/([^/]+)\/open$/,
      );
      if (workbuddyOpenRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertLoopbackRequest(request);
        assertNoQuery(url.searchParams, "WorkBuddy session open");
        await assertEmptyRequestBody(request, "POST /api/local/workbuddy/sessions/:id/open");
        const sessionId = decodeRouteSegment(workbuddyOpenRoute[1], "Session id");
        return sendJson(response, 200, await workbuddyTaskLauncher.openSession(sessionId));
      }

      if (pathname === "/api/projects") {
        if (request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/projects does not accept query parameters");
          }
          return sendJson(response, 200, { projects: database.listProjects() });
        }
        if (request.method === "POST") {
          const project = database.createProject(parseProjectCreate(await readJson(request)));
          events.emit("project.created", { project });
          return sendJson(response, 201, { project });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const workflowWorkspaceRoute = pathname.match(/^\/api\/projects\/([^/]+)\/workflow-workspace$/);
      if (workflowWorkspaceRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Workflow workspace routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(workflowWorkspaceRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method === "GET") {
          return sendJson(response, 200, { workflow: database.getWorkflowWorkspace(projectId) });
        }
        if (request.method === "PUT") {
          const input = parseWorkflowWorkspaceSave(await readJson(request));
          const workflow = database.saveWorkflowWorkspace(projectId, input.version, input.workspace);
          events.emit("workflow.updated", {
            projectId,
            workflowVersion: workflow.version,
          });
          return sendJson(response, 200, { workflow });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      const developmentContextsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/development-contexts$/);
      if (developmentContextsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const unknownQuery = [...url.searchParams.keys()].filter((key) => (
          !["codexProjectId", "codexThreadId", "workspacePath"].includes(key)
        ));
        if (unknownQuery.length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${unknownQuery[0]}`);
        }
        let projectId;
        try {
          projectId = decodeURIComponent(developmentContextsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const project = currentCloudConfig.remoteUrl
          ? {
            id: projectId,
            workspacePath: currentCloudConfig.projectMappings[projectId] ?? null,
          }
          : database.getProject(projectId);
        if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
        const codexProjectId = stringField(url.searchParams.get("codexProjectId") ?? null, "codexProjectId", {
          nullable: true,
          maxLength: 128,
        });
        const codexThreadId = stringField(url.searchParams.get("codexThreadId") ?? null, "codexThreadId", {
          nullable: true,
          maxLength: 256,
        });
        const deviceWorkspacePath = stringField(
          url.searchParams.get("workspacePath") ?? null,
          "workspacePath",
          { nullable: true, maxLength: 4096 },
        );
        if (deviceWorkspacePath?.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
        }
        const workspacePath = deviceWorkspacePath ?? await resolveProjectWorkspace(
          project,
          codexProjectId,
          codexThreadId,
          resolved.codexStatePath,
          resolved.codexProcessesPath,
        );
        return sendJson(response, 200, await scanDevelopmentContexts(workspacePath));
      }

      if (pathname === "/api/tasks") {
        if (request.method === "GET") {
          return sendJson(response, 200, { tasks: database.listTasks(parseTaskFilters(url.searchParams)) });
        }
        if (request.method === "POST") {
          const actor = actorFromRequest(request);
          const { assigneeTarget, ...input } = parseTaskCreate(await readJson(request));
          await assertAssignableAgent(assigneeTarget);
          const task = database.createTask({
            ...input,
            threadId: codexOnlyThreadId(request, input.threadId),
            actor,
            assignee: resolveAssignee(assigneeTarget, actor),
          });
          rememberAgentSession(database, request, task.id, input.threadId);
          events.emit("task.created", { task });
          return sendJson(response, 201, { task });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      if (pathname === "/api/events") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/events does not accept query parameters");
        }
        events.connect(request, response);
        return;
      }

      const taskRelationRoute = pathname.match(
        /^\/api\/tasks\/([^/]+)\/relations\/([^/]+)\/([^/]+)$/,
      );
      if (taskRelationRoute) {
        let taskId;
        let type;
        let relatedTaskId;
        try {
          taskId = decodeURIComponent(taskRelationRoute[1]);
          type = decodeURIComponent(taskRelationRoute[2]);
          relatedTaskId = decodeURIComponent(taskRelationRoute[3]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task relation path contains invalid encoding");
        }
        if (
          taskId.length === 0
          || taskId.length > 128
          || relatedTaskId.length === 0
          || relatedTaskId.length > 128
        ) {
          throw new ApiError(400, "INVALID_PATH", "Task relation task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Task relation routes do not accept query parameters");
        }
        const relationType = parseIssueRelationType(type);
        if (request.method === "POST") {
          const { version, threadId } = parseArchive(await readJson(request));
          const result = database.addTaskRelation(
            taskId,
            version,
            relationType,
            relatedTaskId,
            threadId,
          );
          events.emit("task.relation.updated", result);
          return sendJson(response, 200, result);
        }
        if (request.method === "DELETE") {
          const { version, threadId } = parseArchive(await readJson(request));
          const result = database.removeTaskRelation(
            taskId,
            version,
            relationType,
            relatedTaskId,
            threadId,
          );
          events.emit("task.relation.updated", result);
          return sendJson(response, 200, result);
        }
        return methodNotAllowed(response, ["POST", "DELETE"]);
      }

      const taskCommentsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
      if (taskCommentsRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskCommentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Comment routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { comments: database.listComments(taskId) });
        }
        if (request.method === "POST") {
          const comment = database.createComment(taskId, {
            ...parseCommentCreate(await readJson(request)),
            actor: actorFromRequest(request),
          });
          const task = database.getTask(taskId);
          rememberAgentSession(database, request, task?.id, comment.threadId);
          events.emit("comment.created", { comment, task });
          return sendJson(response, 201, { comment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const commentRoute = pathname.match(/^\/api\/comments\/([^/]+)$/);
      if (commentRoute) {
        let id;
        try {
          id = decodeURIComponent(commentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Comment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Comment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Comment routes do not accept query parameters");
        }
        if (request.method === "PATCH") {
          const patch = parseCommentPatch(await readJson(request));
          const comment = database.updateComment(id, patch.version, patch.body, patch.threadId);
          const task = database.getTask(comment.taskId);
          events.emit("comment.updated", { comment, task });
          return sendJson(response, 200, { comment });
        }
        if (request.method === "DELETE") {
          const { version } = parseArchive(await readJson(request));
          const comment = database.deleteComment(id, version);
          for (const attachment of comment.attachments) {
            try {
              await unlink(path.join(resolved.attachmentsDirectory, attachment.id));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          const task = database.getTask(comment.taskId);
          events.emit("comment.deleted", { comment, task });
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["PATCH", "DELETE"]);
      }

      const commentAttachmentsRoute = pathname.match(/^\/api\/comments\/([^/]+)\/attachments$/);
      if (commentAttachmentsRoute) {
        let commentId;
        try {
          commentId = decodeURIComponent(commentAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Comment id contains invalid encoding");
        }
        if (commentId.length === 0 || commentId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Comment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { attachments: database.listCommentAttachments(commentId) });
        }
        if (request.method === "POST") {
          const comment = database.getComment(commentId);
          if (!comment) throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
          const metadata = parseAttachmentHeaders(request);
          const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
          const id = randomUUID();
          await mkdir(resolved.attachmentsDirectory, { recursive: true });
          const storagePath = path.join(resolved.attachmentsDirectory, id);
          await writeFile(storagePath, body, { flag: "wx" });
          let attachment;
          try {
            attachment = database.createCommentAttachment(commentId, { id, ...metadata, size: body.length });
          } catch (error) {
            await unlink(storagePath);
            throw error;
          }
          const task = database.getTask(comment.taskId);
          events.emit("attachment.created", { attachment, comment: database.getComment(commentId), task });
          return sendJson(response, 201, { attachment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const taskAttachmentsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/attachments$/);
      if (taskAttachmentsRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { attachments: database.listAttachments(taskId) });
        }
        if (request.method === "POST") {
          const task = database.getTask(taskId);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
          const metadata = parseAttachmentHeaders(request);
          const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
          const id = randomUUID();
          await mkdir(resolved.attachmentsDirectory, { recursive: true });
          const storagePath = path.join(resolved.attachmentsDirectory, id);
          await writeFile(storagePath, body, { flag: "wx" });
          let attachment;
          try {
            attachment = database.createAttachment(taskId, { id, ...metadata, size: body.length });
          } catch (error) {
            await unlink(storagePath);
            throw error;
          }
          events.emit("attachment.created", { attachment, task });
          return sendJson(response, 201, { attachment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const attachmentContentRoute = pathname.match(/^\/api\/attachments\/([^/]+)\/content$/);
      if (attachmentContentRoute) {
        let id;
        try {
          id = decodeURIComponent(attachmentContentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Attachment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Attachment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed(response, ["GET", "HEAD"]);
        }
        const attachment = database.getAttachment(id);
        if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
        const body = await readFile(path.join(resolved.attachmentsDirectory, attachment.id));
        const encodedFilename = encodeURIComponent(attachment.filename).replace(/['()*]/g, (character) => (
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`
        ));
        const canOpenInline = INLINE_ATTACHMENT_TYPES.has(attachment.contentType);
        response.writeHead(200, {
          "cache-control": "private, no-store",
          "content-disposition": `${canOpenInline ? "inline" : "attachment"}; filename*=UTF-8''${encodedFilename}`,
          "content-length": body.length,
          "content-security-policy": "sandbox; default-src 'none'",
          "content-type": canOpenInline ? attachment.contentType : "application/octet-stream",
        });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }

      const attachmentRoute = pathname.match(/^\/api\/attachments\/([^/]+)$/);
      if (attachmentRoute) {
        let id;
        try {
          id = decodeURIComponent(attachmentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Attachment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Attachment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method !== "DELETE") return methodNotAllowed(response, ["DELETE"]);
        const attachment = database.getAttachment(id);
        if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
        try {
          await unlink(path.join(resolved.attachmentsDirectory, attachment.id));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        database.deleteAttachment(id);
        const task = database.getTask(attachment.taskId);
        events.emit("attachment.deleted", { attachment, task });
        return sendEmpty(response, 204);
      }

      const taskRoute = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(archive|restore|move|agent-sessions))?$/);
      if (taskRoute) {
        let id;
        try {
          id = decodeURIComponent(taskRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        const action = taskRoute[2];
        if (!action && request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/tasks/:id does not accept query parameters");
          }
          const task = database.getTask(id);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          return sendJson(response, 200, { task: withAgentSessions(database, task) });
        }
        if (!action && request.method === "PATCH") {
          const { version, changes, threadId, assigneeTarget } = parseTaskPatch(await readJson(request));
          const previous = database.getTask(id);
          if (assigneeTarget !== undefined) {
            const nextAssignee = resolveAssignee(assigneeTarget, actorFromRequest(request));
            // 只在负责人真的换了 Agent 时校验；保留已有负责人不需要它仍然 ready。
            if (previous?.assignee?.id !== nextAssignee.id) {
              await assertAssignableAgent(assigneeTarget);
            }
            changes.assignee = nextAssignee;
          }
          const task = database.updateTask(id, version, changes, codexOnlyThreadId(request, threadId));
          rememberAgentSession(database, request, task.id, threadId);
          events.emit("task.updated", { task });
          const agentStart = await startAssignedAgentOnTransition(request, previous, task);
          return sendJson(response, 200, {
            task: withAgentSessions(database, database.getTask(task.id)),
            ...(agentStart ? { agentStart } : {}),
          });
        }
        if (action === "move" && request.method === "POST") {
          const move = parseMove(await readJson(request));
          const previous = database.getTask(id);
          const task = database.moveTask(
            id,
            move.version,
            move.status,
            move.sortOrder,
            codexOnlyThreadId(request, move.threadId),
          );
          rememberAgentSession(database, request, task.id, move.threadId);
          events.emit("task.moved", { task });
          const agentStart = await startAssignedAgentOnTransition(request, previous, task);
          return sendJson(response, 200, {
            task: withAgentSessions(database, database.getTask(task.id)),
            ...(agentStart ? { agentStart } : {}),
          });
        }
        if (action === "agent-sessions" && request.method === "POST") {
          const binding = parseAgentSessionBinding(await readJson(request));
          const task = database.bindAgentSession(
            id,
            binding.agentKind,
            binding.sessionId,
            binding.previousSessionId,
          );
          const decorated = withAgentSessions(database, task);
          events.emit("task.updated", { task: decorated });
          return sendJson(response, 200, { task: decorated });
        }
        if (action === "archive" && request.method === "POST") {
          const { version, threadId } = parseArchive(await readJson(request));
          const task = database.archiveTask(id, version, codexOnlyThreadId(request, threadId));
          events.emit("task.archived", { task });
          return sendJson(response, 200, { task });
        }
        if (action === "restore" && request.method === "POST") {
          const { version, threadId } = parseArchive(await readJson(request));
          const task = database.restoreTask(id, version, codexOnlyThreadId(request, threadId));
          events.emit("task.restored", { task });
          return sendJson(response, 200, { task });
        }
        return methodNotAllowed(response, action ? ["POST"] : ["GET", "PATCH"]);
      }

      if (pathname.startsWith("/api/")) {
        throw new ApiError(404, "NOT_FOUND", "API route not found");
      }
      if (await serveStatic(request, response, pathname, resolved.staticDirectory)) return;
      throw new ApiError(404, "NOT_FOUND", "Resource not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error instanceof ApiError) {
        const payload = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) payload.error.details = error.details;
        sendJson(response, error.status, payload);
        return;
      }
      if (error instanceof CloudProxyError) {
        const payload = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) payload.error.details = error.details;
        sendJson(response, error.status, payload);
        return;
      }
      console.error(error);
      sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
    }
  });

  let listening = false;
  return {
    database,
    aiChat,
    server,
    options: resolved,
    async listen({ host = "127.0.0.1", port = resolvePort() } = {}) {
      if (host !== "127.0.0.1" && host !== "0.0.0.0") {
        throw new Error("Taskboard server must bind to 127.0.0.1 or 0.0.0.0");
      }
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Taskboard server did not expose a TCP listening address"));
            return;
          }
          try {
            taskctlRuntime.initialize(`http://127.0.0.1:${address.port}`);
            resolve();
          } catch (error) {
            reject(error);
          }
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      listening = true;
      return server.address();
    },
    async close() {
      // `server.close()` first, so the port stops accepting before AI shutdown.
      const serverClosed = listening
        ? new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          })
        : Promise.resolve();
      events.close();
      for (const response of aiEventResponses) response.end();
      aiEventResponses.clear();
      await aiChat.close();
      // Event streams and idle keep-alive sockets never end on their own, so
      // `server.close()` alone waits forever and keeps the port bound — which
      // makes the next `node --watch` restart fail to bind.
      if (listening) server.closeAllConnections();
      await serverClosed;
      listening = false;
      database.close();
    },
  };
}
