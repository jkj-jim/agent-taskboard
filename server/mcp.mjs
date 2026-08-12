/**
 * Exposes the taskboard as an MCP server over the Streamable HTTP transport.
 *
 * This module owns the protocol only: it frames JSON-RPC, validates tool
 * arguments, and forwards every board operation to the injected database, so an
 * MCP client reads and writes exactly what the web UI and `taskctl` do. It holds
 * no state, opens no socket and knows no identity of its own — the host route in
 * `server/app.mjs` injects the database and the actor that authors the writes.
 */

import { TASK_STATUSES, isTaskStatus } from "../shared/domain.mjs";
import { ApiError } from "./database.mjs";

const JSONRPC_VERSION = "2.0";
/** Clients that omit `protocolVersion` get the revision this was verified on. */
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_SERVER_VERSION = "0.1.0";
const TASK_ID_MAX_LENGTH = 128;
const PROJECT_ID_MAX_LENGTH = 128;
const COMMENT_BODY_MAX_LENGTH = 100_000;
const DESCRIPTION_PREVIEW_LENGTH = 120;
/** Finished work stays out of the index unless a status is asked for, like `taskctl issue list`. */
const TERMINAL_TASK_STATUSES = new Set(["done", "canceled"]);

/** Turns the board's error codes into the next action an agent should take. */
const ERROR_HINTS = new Map([
  ["VERSION_CONFLICT", "任务已被其他人改动。重新调用 get_task 读取最新 version 和评论，确认改动后再重试。"],
  ["TASK_NOT_FOUND", "taskId 必须是任务 identifier（如 LOCAL-12）或任务 uuid，可先用 list_tasks 查找。"],
  ["PROJECT_NOT_FOUND", "projectId 必须是项目 id（如 local），不是项目名称。"],
]);

const INSTRUCTIONS = "任务看板通道。用 list_tasks 找到任务，用 get_task 读完整上下文（描述、全部评论、关系、version），"
  + "进展和交付结果用 add_comment 写回同一个任务，状态推进用 move_task 并带上刚读到的 version。"
  + "认领后移到 in_progress，自检完成并写好交付评论后移到 in_review；只有用户明确验收才移到 done。";

const TOOLS = [
  {
    name: "list_tasks",
    description: "列出一个项目下的任务索引，用来找到该处理哪个任务。每条返回 taskId（uuid）、identifier（如 LOCAL-12）、"
      + "标题、状态、优先级、标签、负责人、version 和描述摘要，按状态和看板顺序排列。"
      + "省略 status 时只返回未归档且未结束的任务（不含 done 和 canceled）；要查已完成或已取消的历史任务必须显式传 status。"
      + "拿到 identifier 后用 get_task 读取完整上下文，不要只依据这里的摘要动手。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "项目 id，例如 local。这是项目标识而不是项目名称，不确定时先向用户确认。",
          minLength: 1,
          maxLength: PROJECT_ID_MAX_LENGTH,
        },
        status: {
          type: "string",
          enum: TASK_STATUSES,
          description: "可选。只返回该状态的任务；省略时返回项目内所有未归档、未结束的任务。",
        },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_task",
    description: "读取单个任务的完整上下文：描述全文、状态、优先级、标签、负责人、version、父子与阻塞等关系、任务附件，"
      + "以及按时间排序的全部评论。动手前必须先读一次——评论里通常有最新要求、返工意见和验收口径，它们和描述同等重要。"
      + "返回的 version 是乐观并发版本号，move_task 要用它。"
      + "描述或评论里的 ![alt](/api/attachments/<id>/content) 表示位于该处的行内图片。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "任务 identifier（如 LOCAL-12）或任务 uuid，两种都支持。",
          minLength: 1,
          maxLength: TASK_ID_MAX_LENGTH,
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "add_comment",
    description: "给任务追加一条评论，这是把进展、方案、交付结果、疑问或阻塞写回看板的通道。"
      + "评论内容支持 Markdown，作者记为当前 MCP 身份；追加评论不需要 version，也不会和别人的编辑冲突，是最安全的写回方式。"
      + "写精炼的交接信息而不是过程日志：交付说明以「交付：」开头，需要用户拍板用「需决策：」，无法继续用「阻塞：」。"
      + "同一轮不要拆成多条评论，也不要改写旧评论——新一轮追加新评论。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "任务 identifier（如 LOCAL-12）或任务 uuid，两种都支持。",
          minLength: 1,
          maxLength: TASK_ID_MAX_LENGTH,
        },
        body: {
          type: "string",
          description: `评论正文，支持 Markdown，最长 ${COMMENT_BODY_MAX_LENGTH} 字符，不能为空白。`,
          minLength: 1,
          maxLength: COMMENT_BODY_MAX_LENGTH,
        },
      },
      required: ["taskId", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "move_task",
    description: "推进任务状态。必须带 expectedVersion，版本不匹配时不写入，从而避免覆盖别人的并发改动。"
      + "常规流程：认领后移到 in_progress，自检通过并写好交付评论后移到 in_review，无法继续移到 blocked，不再继续移到 canceled。"
      + "in_review 之后只有用户明确验收或明确要求标记完成才能移到 done，Agent 自检不能替代验收，不要自己从 in_review 跳到 done。"
      + "返回 VERSION_CONFLICT 表示任务已被改动，重新 get_task 读到最新 version 和评论后再决定是否重试。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "任务 identifier（如 LOCAL-12）或任务 uuid，两种都支持。",
          minLength: 1,
          maxLength: TASK_ID_MAX_LENGTH,
        },
        status: {
          type: "string",
          enum: TASK_STATUSES,
          description: "目标状态。",
        },
        expectedVersion: {
          type: "integer",
          description: "最近一次 list_tasks 或 get_task 读到的 version，必须是当前版本号，否则拒绝写入。",
          minimum: 1,
        },
      },
      required: ["taskId", "status", "expectedVersion"],
      additionalProperties: false,
    },
  },
];

/** A JSON-RPC level failure: malformed request, bad arguments, unknown method. */
class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/* ------------------------------------------------------------ argument parsing */

function assertKnownArguments(args, allowed) {
  if (args === undefined || args === null) return {};
  if (!isPlainObject(args)) {
    throw new RpcError(-32602, "'arguments' 必须是一个对象");
  }
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new RpcError(
      -32602,
      `未知参数 ${unknown.map((key) => `'${key}'`).join(", ")}；可用参数：${allowed.join(", ")}`,
    );
  }
  return args;
}

function requireString(args, name, maxLength) {
  const value = args[name];
  if (value === undefined) {
    throw new RpcError(-32602, `缺少必填参数 '${name}'`);
  }
  if (typeof value !== "string") {
    throw new RpcError(-32602, `'${name}' 必须是字符串`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new RpcError(-32602, `'${name}' 不能为空`);
  }
  if (normalized.length > maxLength) {
    throw new RpcError(-32602, `'${name}' 不能超过 ${maxLength} 个字符`);
  }
  return normalized;
}

function optionalStatus(args, name) {
  if (args[name] === undefined || args[name] === null) return undefined;
  return requireStatus(args, name);
}

function requireStatus(args, name) {
  const value = args[name];
  if (typeof value !== "string" || !isTaskStatus(value)) {
    throw new RpcError(-32602, `'${name}' 必须是 ${TASK_STATUSES.join(", ")} 之一`);
  }
  return value;
}

function requireVersion(args, name) {
  const value = args[name];
  if (value === undefined) {
    throw new RpcError(-32602, `缺少必填参数 '${name}'`);
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new RpcError(-32602, `'${name}' 必须是正整数，取自最近一次读取到的 version`);
  }
  return value;
}

/* -------------------------------------------------------------- board shaping */

function descriptionPreview(description) {
  const normalized = typeof description === "string" ? description.replace(/\s+/gu, " ").trim() : "";
  const characters = Array.from(normalized);
  return {
    descriptionPreview: characters.slice(0, DESCRIPTION_PREVIEW_LENGTH).join(""),
    descriptionTruncated: characters.length > DESCRIPTION_PREVIEW_LENGTH,
  };
}

function actorSummary(value) {
  return value ? { type: value.type, id: value.id, name: value.name } : null;
}

function taskListEntry(task) {
  return {
    taskId: task.id,
    identifier: task.identifier,
    title: task.title,
    status: task.status,
    priority: task.priority,
    labels: task.labels ?? [],
    assignee: actorSummary(task.assignee),
    version: task.version,
    updatedAt: task.updatedAt,
    ...descriptionPreview(task.description),
  };
}

function relationEntries(relations = {}) {
  const summarize = (task) => ({
    taskId: task.id,
    identifier: task.identifier,
    title: task.title,
    status: task.status,
  });
  const list = (value) => (Array.isArray(value) ? value.map(summarize) : []);
  return {
    parent: relations.parent ? summarize(relations.parent) : null,
    subIssues: list(relations.subIssues),
    blockedBy: list(relations.blockedBy),
    blocks: list(relations.blocks),
    related: list(relations.related),
  };
}

function attachmentEntry(attachment) {
  return {
    attachmentId: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
  };
}

function commentEntry(comment) {
  const attachments = Array.isArray(comment.attachments) ? comment.attachments : [];
  return {
    commentId: comment.id,
    version: comment.version,
    authorType: comment.authorType,
    authorName: comment.authorName,
    createdAt: comment.createdAt,
    body: comment.body,
    attachments: attachments.map(attachmentEntry),
  };
}

function taskDetail(task) {
  return {
    taskId: task.id,
    identifier: task.identifier,
    projectId: task.projectId,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    labels: task.labels ?? [],
    assignee: actorSummary(task.assignee),
    version: task.version,
    dueDate: task.dueDate ?? null,
    developmentContext: task.developmentContext ?? null,
    archivedAt: task.archivedAt ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    relations: relationEntries(task.relations),
  };
}

/* ------------------------------------------------------------- tool result glue */

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

/** Board failures stay inside the tool result so the agent can read and react. */
function toolErrorResult(error) {
  const code = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
  const payload = {
    ok: false,
    code,
    message: errorMessage(error),
    ...(error instanceof ApiError && error.details ? { details: error.details } : {}),
    ...(ERROR_HINTS.has(code) ? { hint: ERROR_HINTS.get(code) } : {}),
  };
  return { ...toolResult(payload), isError: true };
}

/* -------------------------------------------------------------- http responses */

function jsonHttpResponse(status, value, headers = {}) {
  return {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
    body: JSON.stringify(value),
  };
}

function sseHttpResponse(value) {
  return {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive",
    },
    body: `event: message\ndata: ${JSON.stringify(value)}\n\n`,
  };
}

function acceptedHttpResponse() {
  return { status: 202, headers: { "cache-control": "no-store" }, body: "" };
}

function rpcErrorEnvelope(id, code, message, data) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function acceptsEventStream(accept) {
  const value = Array.isArray(accept) ? accept.join(",") : accept;
  return typeof value === "string" && value.includes("text/event-stream");
}

/**
 * Builds the MCP service for one board.
 *
 * @param {object} options
 * @param {object} options.database  TaskboardDatabase instance; every board read and write goes through it.
 * @param {object} options.actor     Author identity for writes, e.g. `{ type, id, name, avatarUrl }`.
 * @param {string} [options.serverName]
 * @param {string} [options.serverVersion]
 */
export function createMcpService({ database, actor, serverName = "taskboard", serverVersion }) {
  if (!database) {
    throw new TypeError("createMcpService requires a database");
  }
  if (!actor || typeof actor.type !== "string" || typeof actor.id !== "string" || typeof actor.name !== "string") {
    throw new TypeError("createMcpService requires an actor with type, id and name");
  }
  const serverInfo = { name: serverName, version: serverVersion ?? DEFAULT_SERVER_VERSION };
  const writeActor = {
    type: actor.type,
    id: actor.id,
    name: actor.name,
    avatarUrl: actor.avatarUrl ?? null,
  };

  function requireTask(taskId) {
    const task = database.getTask(taskId);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
    }
    return task;
  }

  const handlers = {
    list_tasks(rawArguments) {
      const args = assertKnownArguments(rawArguments, ["projectId", "status"]);
      const projectId = requireString(args, "projectId", PROJECT_ID_MAX_LENGTH);
      const status = optionalStatus(args, "status");
      if (!database.getProject(projectId)) {
        const available = database.listProjects().map((project) => project.id).join(", ");
        throw new ApiError(
          404,
          "PROJECT_NOT_FOUND",
          `Project '${projectId}' does not exist${available ? `; available projects: ${available}` : ""}`,
        );
      }
      const tasks = database.listTasks({ projectId, status, archived: "false" })
        .filter((task) => status !== undefined || !TERMINAL_TASK_STATUSES.has(task.status));
      return {
        projectId,
        status: status ?? null,
        count: tasks.length,
        tasks: tasks.map(taskListEntry),
      };
    },

    get_task(rawArguments) {
      const args = assertKnownArguments(rawArguments, ["taskId"]);
      const taskId = requireString(args, "taskId", TASK_ID_MAX_LENGTH);
      const task = requireTask(taskId);
      return {
        task: taskDetail(task),
        comments: database.listComments(task.id).map(commentEntry),
        attachments: database.listAttachments(task.id).map(attachmentEntry),
      };
    },

    add_comment(rawArguments) {
      const args = assertKnownArguments(rawArguments, ["taskId", "body"]);
      const taskId = requireString(args, "taskId", TASK_ID_MAX_LENGTH);
      const body = requireString(args, "body", COMMENT_BODY_MAX_LENGTH);
      const task = requireTask(taskId);
      const comment = database.createComment(task.id, { body, actor: writeActor });
      return {
        ok: true,
        taskId: task.id,
        identifier: task.identifier,
        commentId: comment.id,
        authorType: comment.authorType,
        authorName: comment.authorName,
        createdAt: comment.createdAt,
        body: comment.body,
      };
    },

    move_task(rawArguments) {
      const args = assertKnownArguments(rawArguments, ["taskId", "status", "expectedVersion"]);
      const taskId = requireString(args, "taskId", TASK_ID_MAX_LENGTH);
      const status = requireStatus(args, "status");
      const expectedVersion = requireVersion(args, "expectedVersion");
      const previous = requireTask(taskId);
      const task = database.moveTask(previous.id, expectedVersion, status);
      return {
        ok: true,
        taskId: task.id,
        identifier: task.identifier,
        previousStatus: previous.status,
        status: task.status,
        version: task.version,
        updatedAt: task.updatedAt,
      };
    },
  };

  function callTool(params) {
    const name = params?.name;
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
    if (!handler) {
      throw new RpcError(
        -32602,
        `未知工具 '${name}'；可用工具：${TOOLS.map((tool) => tool.name).join(", ")}`,
      );
    }
    try {
      return toolResult(handler(params?.arguments ?? {}));
    } catch (error) {
      if (error instanceof RpcError) throw error;
      return toolErrorResult(error);
    }
  }

  async function handleMethod(method, params) {
    if (method === "initialize") {
      const requested = params?.protocolVersion;
      return {
        protocolVersion: typeof requested === "string" && requested.length > 0
          ? requested
          : FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions: INSTRUCTIONS,
      };
    }
    if (method === "ping") return {};
    if (method === "tools/list") return { tools: TOOLS };
    if (method === "tools/call") return callTool(params);
    throw new RpcError(-32601, `Method not found: ${method}`);
  }

  /** Answers one JSON-RPC message, or `null` when nothing should be sent back. */
  async function handleMessage(message) {
    const isRequest = isPlainObject(message) && message.id !== undefined && message.id !== null;
    // Notifications (`notifications/initialized`) and responses expect no reply.
    if (!isRequest) return null;
    if (message.jsonrpc !== JSONRPC_VERSION || typeof message.method !== "string") {
      return rpcErrorEnvelope(message.id, -32600, "Invalid Request");
    }
    try {
      return {
        jsonrpc: JSONRPC_VERSION,
        id: message.id,
        result: await handleMethod(message.method, message.params),
      };
    } catch (error) {
      if (error instanceof RpcError) {
        return rpcErrorEnvelope(message.id, error.code, error.message, error.data);
      }
      return rpcErrorEnvelope(message.id, -32603, errorMessage(error));
    }
  }

  /**
   * Handles one Streamable HTTP exchange. The caller supplies the method, the
   * Accept header and the already-read body, and writes the returned status,
   * headers and body back to the client.
   */
  async function handleHttp({ method, accept, bodyText } = {}) {
    if (String(method ?? "").toUpperCase() !== "POST") {
      return jsonHttpResponse(
        405,
        rpcErrorEnvelope(null, -32000, "MCP 通道只接受 POST 请求"),
        { allow: "POST" },
      );
    }

    let message;
    try {
      const raw = typeof bodyText === "string" ? bodyText : "";
      if (raw.trim().length === 0) throw new Error("请求体为空");
      message = JSON.parse(raw);
    } catch (error) {
      return jsonHttpResponse(400, rpcErrorEnvelope(null, -32700, `Parse error: ${errorMessage(error)}`));
    }

    const wantsEventStream = acceptsEventStream(accept);
    if (Array.isArray(message)) {
      const replies = [];
      for (const entry of message) {
        const reply = await handleMessage(entry);
        if (reply) replies.push(reply);
      }
      // A notification-only batch is acknowledged with no body.
      if (replies.length === 0) return acceptedHttpResponse();
      return wantsEventStream ? sseHttpResponse(replies) : jsonHttpResponse(200, replies);
    }

    const reply = await handleMessage(message);
    if (!reply) return acceptedHttpResponse();
    return wantsEventStream ? sseHttpResponse(reply) : jsonHttpResponse(200, reply);
  }

  return { handleHttp, handleMessage, listTools: () => TOOLS, serverInfo };
}
