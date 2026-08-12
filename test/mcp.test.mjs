import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { createMcpService } from "../server/mcp.mjs";

const USER = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
const MCP_ACTOR = { type: "agent", id: "mcp-test-agent", name: "MCP Test Agent", avatarUrl: null };

const fixtures = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function createFixture(actor = MCP_ACTOR) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-mcp-test-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  fixtures.push({ database, directory });
  const service = createMcpService({ database, actor, serverVersion: "9.9.9" });
  return { database, service };
}

function seedTask(database, overrides = {}) {
  return database.createTask({
    projectId: "local",
    title: "任务标题",
    description: "",
    status: "todo",
    priority: "none",
    labels: [],
    threadId: null,
    workflowId: null,
    developmentContext: null,
    dueDate: null,
    recurrence: null,
    actor: USER,
    assignee: USER,
    ...overrides,
  });
}

async function post(service, message, options = {}) {
  const { method = "POST", accept = "application/json" } = options;
  return service.handleHttp({
    method,
    accept,
    bodyText: message === undefined ? undefined : JSON.stringify(message),
  });
}

function jsonBody(result) {
  assert.match(result.headers["content-type"], /^application\/json/);
  return JSON.parse(result.body);
}

async function callTool(service, name, args) {
  const result = await post(service, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name, arguments: args },
  });
  assert.equal(result.status, 200);
  const payload = jsonBody(result);
  assert.equal(payload.id, 7);
  assert.equal(payload.error, undefined);
  return payload.result;
}

test("initialize echoes the client protocol version and falls back when it is missing", async () => {
  const { service } = await createFixture();

  const echoed = jsonBody(await post(service, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
  }));
  assert.equal(echoed.result.protocolVersion, "2025-03-26");
  assert.deepEqual(echoed.result.serverInfo, { name: "taskboard", version: "9.9.9" });
  assert.deepEqual(echoed.result.capabilities, { tools: { listChanged: false } });
  assert.match(echoed.result.instructions, /get_task/);

  const defaulted = jsonBody(await post(service, {
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { capabilities: {} },
  }));
  assert.equal(defaulted.result.protocolVersion, "2025-06-18");
});

test("notifications without an id are acknowledged with an empty 202", async () => {
  const { service } = await createFixture();

  const single = await post(service, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(single.status, 202);
  assert.equal(single.body, "");

  const batch = await post(service, [
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
  ]);
  assert.equal(batch.status, 202);
  assert.equal(batch.body, "");
});

test("tools/list exposes four unprefixed tools with strict schemas", async () => {
  const { service } = await createFixture();

  const payload = jsonBody(await post(service, { jsonrpc: "2.0", id: 3, method: "tools/list" }));
  const tools = payload.result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["list_tasks", "get_task", "add_comment", "move_task"]);
  assert.deepEqual(service.listTools().map((tool) => tool.name), tools.map((tool) => tool.name));

  const required = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema.required]));
  assert.deepEqual(required, {
    list_tasks: ["projectId"],
    get_task: ["taskId"],
    add_comment: ["taskId", "body"],
    move_task: ["taskId", "status", "expectedVersion"],
  });
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.description.length > 40, `${tool.name} needs a descriptive description`);
  }
});

test("list_tasks returns live board rows, hides finished work, and filters by status", async () => {
  const { database, service } = await createFixture();
  seedTask(database, { title: "待办任务", description: "第一行\n第二行" });
  seedTask(database, { title: "进行中的任务", status: "in_progress" });
  seedTask(database, { title: "已完成的任务", status: "done" });

  const listed = await callTool(service, "list_tasks", { projectId: "local" });
  assert.equal(listed.isError, undefined);
  const summary = listed.structuredContent;
  assert.equal(summary.projectId, "local");
  assert.equal(summary.status, null);
  assert.equal(summary.count, 2);
  assert.deepEqual(summary.tasks.map((task) => task.title), ["待办任务", "进行中的任务"]);
  assert.deepEqual(summary.tasks.map((task) => task.identifier), ["LOCAL-1", "LOCAL-2"]);
  assert.equal(summary.tasks[0].descriptionPreview, "第一行 第二行");
  assert.equal(summary.tasks[0].descriptionTruncated, false);
  assert.equal(summary.tasks[0].version, 1);
  assert.deepEqual(summary.tasks[0].assignee, { type: "user", id: "local-user", name: "本地用户" });
  assert.equal(listed.content[0].type, "text");
  assert.deepEqual(JSON.parse(listed.content[0].text), summary);

  const finished = await callTool(service, "list_tasks", { projectId: "local", status: "done" });
  assert.deepEqual(finished.structuredContent.tasks.map((task) => task.title), ["已完成的任务"]);

  const missingProject = await callTool(service, "list_tasks", { projectId: "nope" });
  assert.equal(missingProject.isError, true);
  assert.equal(missingProject.structuredContent.code, "PROJECT_NOT_FOUND");
  assert.match(missingProject.structuredContent.message, /available projects: local/);
});

test("get_task accepts an identifier or a uuid and returns comments, relations, and attachments", async () => {
  const { database, service } = await createFixture();
  const parent = seedTask(database, { title: "父任务" });
  const task = seedTask(database, { title: "子任务", description: "详细描述", priority: "high", labels: ["mcp"] });
  database.addTaskRelation(task.id, task.version, "parent", parent.id);
  database.createComment(task.id, { body: "第一条评论", actor: USER });
  database.createAttachment(task.id, {
    id: randomUUID(),
    filename: "shot.png",
    contentType: "image/png",
    size: 42,
  });

  const byIdentifier = await callTool(service, "get_task", { taskId: task.identifier });
  const detail = byIdentifier.structuredContent;
  assert.equal(detail.task.identifier, "LOCAL-2");
  assert.equal(detail.task.taskId, task.id);
  assert.equal(detail.task.description, "详细描述");
  assert.equal(detail.task.priority, "high");
  assert.deepEqual(detail.task.labels, ["mcp"]);
  assert.equal(detail.task.version, 2, "adding a relation bumps the task version");
  assert.deepEqual(detail.task.relations.parent, {
    taskId: parent.id,
    identifier: parent.identifier,
    title: "父任务",
    status: "todo",
  });
  assert.deepEqual(detail.comments.map((comment) => comment.body), ["第一条评论"]);
  assert.equal(detail.comments[0].authorName, "本地用户");
  assert.deepEqual(detail.attachments.map((attachment) => attachment.filename), ["shot.png"]);
  assert.equal(detail.attachments[0].contentType, "image/png");

  const byUuid = await callTool(service, "get_task", { taskId: task.id });
  assert.deepEqual(byUuid.structuredContent, detail);

  const missing = await callTool(service, "get_task", { taskId: "LOCAL-404" });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.code, "TASK_NOT_FOUND");
});

test("add_comment writes back under the injected actor identity", async () => {
  const { database, service } = await createFixture();
  const task = seedTask(database);

  const added = await callTool(service, "add_comment", {
    taskId: task.identifier,
    body: "交付：MCP 通道已接通。",
  });
  const payload = added.structuredContent;
  assert.equal(added.isError, undefined);
  assert.equal(payload.ok, true);
  assert.equal(payload.identifier, task.identifier);
  assert.equal(payload.authorType, "agent");
  assert.equal(payload.authorName, "MCP Test Agent");

  const stored = database.listComments(task.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, payload.commentId);
  assert.equal(stored[0].body, "交付：MCP 通道已接通。");
  assert.equal(stored[0].authorId, "mcp-test-agent");
  assert.equal(stored[0].authorType, "agent");
  assert.equal(database.getTask(task.id).version, 1, "a comment never bumps the task version");
});

test("move_task advances status with the expected version and reports conflicts", async () => {
  const { database, service } = await createFixture();
  const task = seedTask(database);

  const moved = await callTool(service, "move_task", {
    taskId: task.identifier,
    status: "in_progress",
    expectedVersion: task.version,
  });
  assert.equal(moved.isError, undefined);
  assert.equal(moved.structuredContent.previousStatus, "todo");
  assert.equal(moved.structuredContent.status, "in_progress");
  assert.equal(moved.structuredContent.version, 2);
  assert.equal(database.getTask(task.id).status, "in_progress");

  const stale = await callTool(service, "move_task", {
    taskId: task.identifier,
    status: "in_review",
    expectedVersion: task.version,
  });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.code, "VERSION_CONFLICT");
  assert.deepEqual(stale.structuredContent.details, { expectedVersion: 1, actualVersion: 2 });
  assert.match(stale.structuredContent.hint, /get_task/);
  assert.equal(database.getTask(task.id).status, "in_progress", "a conflicting move changes nothing");
});

test("only POST is accepted on the MCP channel", async () => {
  const { service } = await createFixture();

  for (const method of ["GET", "DELETE", "PUT"]) {
    const result = await post(service, { jsonrpc: "2.0", id: 1, method: "ping" }, { method });
    assert.equal(result.status, 405);
    assert.equal(result.headers.allow, "POST");
    assert.equal(jsonBody(result).error.message, "MCP 通道只接受 POST 请求");
  }
});

test("both SSE and JSON accept headers get a well-formed reply", async () => {
  const { database, service } = await createFixture();
  seedTask(database, { title: "看板任务" });

  const request = { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "list_tasks", arguments: { projectId: "local" } } };

  const json = await post(service, request, { accept: "application/json" });
  assert.equal(json.status, 200);
  assert.match(json.headers["content-type"], /^application\/json/);
  assert.equal(JSON.parse(json.body).result.structuredContent.count, 1);

  const sse = await post(service, request, { accept: "application/json, text/event-stream" });
  assert.equal(sse.status, 200);
  assert.match(sse.headers["content-type"], /^text\/event-stream/);
  assert.ok(sse.body.startsWith("event: message\ndata: "));
  assert.ok(sse.body.endsWith("\n\n"));
  const framed = JSON.parse(sse.body.slice("event: message\ndata: ".length).trim());
  assert.equal(framed.id, 11);
  assert.deepEqual(framed.result.structuredContent.tasks.map((task) => task.title), ["看板任务"]);
});

test("protocol and argument mistakes surface as JSON-RPC errors", async () => {
  const { database, service } = await createFixture();
  const task = seedTask(database);

  const unknownMethod = jsonBody(await post(service, { jsonrpc: "2.0", id: 21, method: "resources/list" }));
  assert.equal(unknownMethod.error.code, -32601);

  const unknownTool = jsonBody(await post(service, {
    jsonrpc: "2.0",
    id: 22,
    method: "tools/call",
    params: { name: "delete_everything", arguments: {} },
  }));
  assert.equal(unknownTool.error.code, -32602);
  assert.match(unknownTool.error.message, /move_task/);

  const missingArgument = jsonBody(await post(service, {
    jsonrpc: "2.0",
    id: 23,
    method: "tools/call",
    params: { name: "get_task", arguments: {} },
  }));
  assert.equal(missingArgument.error.code, -32602);
  assert.match(missingArgument.error.message, /taskId/);

  const badVersion = jsonBody(await post(service, {
    jsonrpc: "2.0",
    id: 24,
    method: "tools/call",
    params: { name: "move_task", arguments: { taskId: task.identifier, status: "in_review", expectedVersion: "1" } },
  }));
  assert.equal(badVersion.error.code, -32602);

  const badStatus = jsonBody(await post(service, {
    jsonrpc: "2.0",
    id: 25,
    method: "tools/call",
    params: { name: "move_task", arguments: { taskId: task.identifier, status: "shipped", expectedVersion: 1 } },
  }));
  assert.equal(badStatus.error.code, -32602);

  const unknownParameter = jsonBody(await post(service, {
    jsonrpc: "2.0",
    id: 26,
    method: "tools/call",
    params: { name: "add_comment", arguments: { taskId: task.identifier, body: "hi", version: 1 } },
  }));
  assert.equal(unknownParameter.error.code, -32602);
  assert.match(unknownParameter.error.message, /'version'/);

  const parseError = jsonBody(await service.handleHttp({ method: "POST", accept: "application/json", bodyText: "{" }));
  assert.equal(parseError.error.code, -32700);
  assert.equal(parseError.id, null);

  const emptyBody = jsonBody(await service.handleHttp({ method: "POST", accept: "application/json", bodyText: "" }));
  assert.equal(emptyBody.error.code, -32700);

  const invalidRequest = jsonBody(await post(service, { id: 27, method: "ping" }));
  assert.equal(invalidRequest.error.code, -32600);
});
