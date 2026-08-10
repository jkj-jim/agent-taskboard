import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { createTaskboardServer } from "../server/index.mjs";
import { SKILL_MARKER } from "../server/agents/prompt.mjs";

const execFile = promisify(execFileCallback);

async function createServerFixture(host = "127.0.0.1", overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-server-"));
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath);
  const workspace = await realpath(workspacePath);
  const codexExecutable = path.join(directory, "fake-codex.mjs");
  await writeFile(codexExecutable, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "debug") {
  process.stdout.write('{"models":[{"slug":"gpt-real","display_name":"GPT Real","description":"","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}],"service_tiers":[]}]}');
} else if (args[0] === "app-server") {
  process.stdin.setEncoding("utf8"); let buffer="";
  process.stdin.on("data", chunk => { buffer += chunk; let i;
    while ((i=buffer.indexOf("\\n"))>=0) { const line=buffer.slice(0,i); buffer=buffer.slice(i+1);
      if (!line.trim()) continue; const message=JSON.parse(line);
      if (message.id===1) process.stdout.write('{"id":1,"result":{}}\\n');
      if (message.id===2) process.stdout.write('{"id":2,"result":{"data":[{"skills":[{"name":"real-skill","enabled":true,"scope":"repo","interface":null}]}]}}\\n');
    }
  });
} else {
  const taskctl = spawnSync("taskctl", ["project", "list", "--json"], { encoding: "utf8" });
  if (taskctl.status !== 0) {
    process.stderr.write(taskctl.stderr || "bare taskctl was not available to Codex");
    process.exit(1);
  }
  JSON.parse(taskctl.stdout);
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.stdout.write('{"type":"thread.started","thread_id":"session-1"}\\n');
    process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\\n');
    process.stdout.write('{"type":"turn.completed"}\\n');
  });
}
`);
  await chmod(codexExecutable, 0o755);
  const claudeExecutable = path.join(directory, "fake-claude.mjs");
  await writeFile(claudeExecutable, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write('{"loggedIn":true}');
} else {
  const taskctl = spawnSync("taskctl", ["project", "list", "--json"], { encoding: "utf8" });
  if (taskctl.status !== 0) {
    process.stderr.write(taskctl.stderr || "bare taskctl was not available to Claude");
    process.exit(1);
  }
  JSON.parse(taskctl.stdout);
  const sessionFlag = args.indexOf("--session-id");
  const resumeFlag = args.indexOf("--resume");
  const sessionId = sessionFlag >= 0 ? args[sessionFlag + 1] : args[resumeFlag + 1];
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:sessionId}) + "\\n");
    process.stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"ok"}\\n');
  });
}
`);
  await chmod(claudeExecutable, 0o755);
  const codexStatePath = path.join(directory, "codex-state.json");
  await writeFile(codexStatePath, JSON.stringify({
    "local-projects": { local: { rootPaths: [workspace] } },
  }));
  const nativeLaunches = [];
  const defaultCodexDesktopController = {
    async inspect() {
      return { available: true };
    },
    async createTask(input) {
      nativeLaunches.push(input);
      if (input.presentation === "foreground") return { status: "prepared" };
      return {
        status: "started",
        sessionId: `00000000-0000-4000-8000-${String(nativeLaunches.length).padStart(12, "0")}`,
      };
    },
  };
  const codexDesktopController = overrides.codexDesktopController
    ?? defaultCodexDesktopController;
  const app = createTaskboardServer({
    dataDirectory: directory,
    claudeExecutable,
    claudeHome: path.join(directory, "claude-home"),
    codexExecutable,
    codexStatePath,
    skillPath: "/fixture/manage-taskboard/SKILL.md",
    codexDesktopController,
  });
  const address = await app.listen({ host, port: 0 });
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    directory,
    nativeLaunches,
    workspace,
    async close() {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function privateLanAddress() {
  return Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => {
      if (entry?.family !== "IPv4" || entry.internal) return false;
      const [first, second] = entry.address.split(".").map(Number);
      return first === 10
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 168)
        || (first === 169 && second === 254);
    })?.address;
}

async function requestFrom(address, port, pathname) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: address,
      port,
      path: pathname,
      headers: { host: `${address}:${port}` },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test("loopback AI API freezes server-owned origin and rejects injected execution fields", async () => {
  const fixture = await createServerFixture();
  try {
    const meta = await request(fixture.baseUrl, "/api/meta");
    assert.equal(meta.body.capabilities.localAiChat, true);
    assert.equal(meta.body.capabilities.nativeCodexTaskLaunch, true);
    const catalog = await request(fixture.baseUrl, "/api/local/ai/catalog?projectId=local");
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.body.models[0].slug, "gpt-real");
    assert.equal(catalog.body.skills[0].id, "real-skill");

    const injected = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local", workspacePath: "/tmp/evil", argv: ["--dangerously-bypass-approvals-and-sandbox"] },
    });
    assert.equal(injected.response.status, 400);
    assert.equal(injected.body.error.code, "UNKNOWN_FIELD");

    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: {
        projectId: "local",
        model: "gpt-real",
        reasoningEffort: "high",
        sandbox: "read-only",
      },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.thread.origin.workspacePath, fixture.workspace);
    const threadId = created.body.thread.id;

    const invalidSkill = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: `hello ${SKILL_MARKER}`, skillIds: ["invented-skill"] },
    });
    assert.equal(invalidSkill.response.status, 400);
    assert.equal(invalidSkill.body.error.code, "INVALID_SKILL");

    const turn = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: `hello ${SKILL_MARKER}`, skillIds: ["real-skill"] },
    });
    assert.equal(turn.response.status, 202);
    assert.equal(turn.body.run.threadId, threadId);

    let snapshot;
    for (let index = 0; index < 100; index += 1) {
      snapshot = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`);
      if (snapshot.body.runs[0]?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(snapshot.body.thread.codexThreadId, "session-1");
    assert.equal(snapshot.body.events.some((event) => event.content === "ok"), true);
  } finally {
    await fixture.close();
  }
});

test("a user move into in progress is launched natively exactly once without codex exec", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "Automatically start this issue",
        status: "todo",
        assigneeTarget: "codex-agent",
      },
    });
    assert.equal(created.response.status, 201);

    const moved = await request(
      fixture.baseUrl,
      `/api/tasks/${created.body.task.id}/move`,
      {
        method: "POST",
        body: {
          version: created.body.task.version,
          status: "in_progress",
          sortOrder: 1024,
        },
      },
    );
    assert.equal(moved.response.status, 200);
    assert.equal(moved.body.agentStart, undefined);
    assert.equal((await request(fixture.baseUrl, "/api/local/ai/threads")).body.threads.length, 0);

    const launchBody = {
      expectedVersion: moved.body.task.version,
      trigger: "status-transition",
      presentation: "background",
      previousSessionId: null,
    };
    const launched = await request(
      fixture.baseUrl,
      `/api/local/codex/tasks/${created.body.task.id}/launch`,
      { method: "POST", body: launchBody },
    );
    assert.equal(launched.response.status, 200);
    assert.equal(launched.body.status, "started");
    assert.equal(launched.body.agentKind, "codex");
    assert.deepEqual(launched.body.task.agentSessions, [
      {
        agentKind: "codex",
        sessionId: launched.body.sessionId,
        updatedAt: launched.body.task.agentSessions[0].updatedAt,
      },
    ]);
    assert.equal(fixture.nativeLaunches.length, 1);
    assert.equal(fixture.nativeLaunches[0].workspacePath, fixture.workspace);
    const taskctlShim = path.join(fixture.directory, "bin", "taskctl");
    assert.match(
      fixture.nativeLaunches[0].instruction,
      new RegExp(`^处理任务 ${created.body.task.identifier}。`),
    );
    assert.equal(fixture.nativeLaunches[0].instruction.includes(`'${taskctlShim}'`), true);
    assert.match(fixture.nativeLaunches[0].instruction, /每一次 Taskboard 操作都使用/);
    assert.match(fixture.nativeLaunches[0].instruction, /issue brief/);
    assert.equal(fixture.nativeLaunches[0].presentation, "background");

    const duplicate = await request(
      fixture.baseUrl,
      `/api/local/codex/tasks/${created.body.task.id}/launch`,
      { method: "POST", body: launchBody },
    );
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.body.sessionId, launched.body.sessionId);
    assert.equal(fixture.nativeLaunches.length, 1);

    const reordered = await request(
      fixture.baseUrl,
      `/api/tasks/${created.body.task.id}/move`,
      {
        method: "POST",
        body: {
          version: launched.body.task.version,
          status: "in_progress",
          sortOrder: 2048,
        },
      },
    );
    assert.equal(reordered.response.status, 200);
    assert.equal(reordered.body.agentStart, undefined);
    const afterReorder = await request(fixture.baseUrl, "/api/local/ai/threads");
    assert.equal(afterReorder.body.threads.length, 0);

    const claimed = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "Agent claim must not recurse",
        status: "todo",
        assigneeTarget: "codex-agent",
      },
    });
    const agentMove = await request(
      fixture.baseUrl,
      `/api/tasks/${claimed.body.task.id}/move`,
      {
        method: "POST",
        headers: {
          "x-taskboard-agent": "codex",
          "x-taskboard-client": "taskctl",
        },
        body: {
          version: claimed.body.task.version,
          status: "in_progress",
          sortOrder: 3072,
        },
      },
    );
    assert.equal(agentMove.response.status, 200);
    assert.equal(agentMove.body.agentStart, undefined);
    const afterAgentClaim = await request(fixture.baseUrl, "/api/local/ai/threads");
    assert.equal(afterAgentClaim.body.threads.length, 0);
    assert.equal(fixture.nativeLaunches.length, 1);
  } finally {
    await fixture.close();
  }
});

test("a manual Codex launch prepares an editable prompt without binding or deduplicating it", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "Prepare this task for manual review",
        status: "todo",
        assigneeTarget: "codex-agent",
      },
    });
    const launchBody = {
      expectedVersion: created.body.task.version,
      trigger: "manual",
      presentation: "foreground",
      previousSessionId: null,
    };

    const first = await request(
      fixture.baseUrl,
      `/api/local/codex/tasks/${created.body.task.id}/launch`,
      { method: "POST", body: launchBody },
    );
    const second = await request(
      fixture.baseUrl,
      `/api/local/codex/tasks/${created.body.task.id}/launch`,
      { method: "POST", body: launchBody },
    );

    assert.equal(first.response.status, 200);
    assert.equal(first.body.status, "prepared");
    assert.equal(first.body.sessionId, undefined);
    assert.equal(first.body.task.version, created.body.task.version);
    assert.equal(first.body.task.agentSessions, undefined);
    assert.equal(second.body.status, "prepared");
    assert.equal(fixture.nativeLaunches.length, 2);
    assert.deepEqual(
      fixture.nativeLaunches.map((launch) => launch.presentation),
      ["foreground", "foreground"],
    );
  } finally {
    await fixture.close();
  }
});

test("native Codex launch failures return the actionable injector error", async () => {
  const fixture = await createServerFixture("127.0.0.1", {
    codexDesktopController: {
      async inspect() {
        return { available: true };
      },
      async createTask() {
        throw new Error("Timed out while selecting the manage-taskboard Skill");
      },
    },
  });
  try {
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "Expose native launch failure",
        status: "todo",
        assigneeTarget: "codex-agent",
      },
    });
    const launched = await request(
      fixture.baseUrl,
      `/api/local/codex/tasks/${created.body.task.id}/launch`,
      {
        method: "POST",
        body: {
          expectedVersion: created.body.task.version,
          trigger: "manual",
          presentation: "foreground",
          previousSessionId: null,
        },
      },
    );
    assert.equal(launched.response.status, 502);
    assert.equal(launched.body.error.code, "CODEX_NATIVE_TASK_LAUNCH_FAILED");
    assert.equal(
      launched.body.error.message,
      "Timed out while selecting the manage-taskboard Skill",
    );
  } finally {
    await fixture.close();
  }
});

test("the native taskctl shim uses the random listening port for reads and later writes", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "Use the runtime taskboard origin",
        status: "todo",
        assigneeTarget: "codex-agent",
      },
    });
    const moved = await request(fixture.baseUrl, `/api/tasks/${created.body.task.id}/move`, {
      method: "POST",
      body: {
        version: created.body.task.version,
        status: "in_progress",
      },
    });
    const launched = await request(
      fixture.baseUrl,
      `/api/local/codex/tasks/${created.body.task.id}/launch`,
      {
        method: "POST",
        body: {
          expectedVersion: moved.body.task.version,
          trigger: "status-transition",
          presentation: "background",
          previousSessionId: null,
        },
      },
    );
    assert.equal(launched.response.status, 200);

    const shimPath = path.join(fixture.directory, "bin", "taskctl");
    const agentEnv = {
      ...process.env,
      CODEX_TASKBOARD_URL: "http://127.0.0.1:1",
      CODEX_THREAD_ID: launched.body.sessionId,
    };
    const brief = JSON.parse((await execFile(
      shimPath,
      ["issue", "brief", created.body.task.identifier, "--json"],
      { env: agentEnv },
    )).stdout);
    assert.equal(brief.task.identifier, created.body.task.identifier);
    assert.equal(brief.task.version, launched.body.task.version);
    assert.deepEqual(brief.comments, []);

    const added = JSON.parse((await execFile(
      shimPath,
      [
        "comment", "add", created.body.task.identifier,
        "--body", "交付：随机端口读写验证通过。",
        "--json",
      ],
      { env: agentEnv },
    )).stdout);
    assert.equal(added.comment.body, "交付：随机端口读写验证通过。");

    const reviewed = JSON.parse((await execFile(
      shimPath,
      [
        "issue", "move", created.body.task.identifier,
        "--status", "in_review",
        "--if-version", String(launched.body.task.version),
        "--json",
      ],
      { env: agentEnv },
    )).stdout);
    assert.equal(reviewed.task.status, "in_review");

    const refreshed = await request(fixture.baseUrl, `/api/tasks/${created.body.task.id}`);
    assert.equal(refreshed.body.task.status, "in_review");
    const comments = await request(
      fixture.baseUrl,
      `/api/tasks/${created.body.task.id}/comments`,
    );
    assert.equal(comments.body.comments[0].body, "交付：随机端口读写验证通过。");
  } finally {
    await fixture.close();
  }
});

test("local agent session binding uses compare-and-set and does not bump idempotent writes", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "Session compare and set",
        status: "in_progress",
        assigneeTarget: "codex-agent",
      },
    });
    const firstSessionId = "33333333-3333-4333-8333-333333333333";
    const secondSessionId = "44444444-4444-4444-8444-444444444444";
    const bind = (sessionId, previousSessionId) => request(
      fixture.baseUrl,
      `/api/tasks/${created.body.task.id}/agent-sessions`,
      {
        method: "POST",
        body: { agentKind: "codex", sessionId, previousSessionId },
      },
    );

    const bound = await bind(firstSessionId, null);
    assert.equal(bound.response.status, 200);
    assert.equal(bound.body.task.threadId, firstSessionId);
    assert.equal(bound.body.task.agentSessions[0].sessionId, firstSessionId);
    assert.equal(bound.body.task.version, created.body.task.version + 1);

    const idempotent = await bind(firstSessionId, null);
    assert.equal(idempotent.response.status, 200);
    assert.equal(idempotent.body.task.version, bound.body.task.version);

    const conflict = await bind(secondSessionId, null);
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, "AGENT_SESSION_CONFLICT");
    assert.equal(conflict.body.error.details.currentSessionId, firstSessionId);
  } finally {
    await fixture.close();
  }
});

test("detail-style patches leave Codex for native launch while Claude keeps its adapter", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "Assign first, then start",
        status: "todo",
        assigneeTarget: "current-user",
      },
    });
    const assigned = await request(fixture.baseUrl, `/api/tasks/${created.body.task.id}`, {
      method: "PATCH",
      body: {
        version: created.body.task.version,
        assigneeTarget: "codex-agent",
      },
    });
    assert.equal(assigned.response.status, 200);
    assert.equal(assigned.body.agentStart, undefined);

    const started = await request(fixture.baseUrl, `/api/tasks/${created.body.task.id}`, {
      method: "PATCH",
      body: {
        version: assigned.body.task.version,
        status: "in_progress",
      },
    });
    assert.equal(started.response.status, 200);
    assert.equal(started.body.agentStart, undefined);
    const native = await request(
      fixture.baseUrl,
      `/api/local/codex/tasks/${created.body.task.id}/launch`,
      {
        method: "POST",
        body: {
          expectedVersion: started.body.task.version,
          trigger: "status-transition",
          presentation: "background",
          previousSessionId: null,
        },
      },
    );
    assert.equal(native.response.status, 200);
    assert.equal(fixture.nativeLaunches.length, 1);

    const alreadyActive = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "Start first, then assign",
        status: "in_progress",
        assigneeTarget: "current-user",
      },
    });
    const assignedWhileActive = await request(
      fixture.baseUrl,
      `/api/tasks/${alreadyActive.body.task.id}`,
      {
        method: "PATCH",
        body: {
          version: alreadyActive.body.task.version,
          assigneeTarget: "claude-agent",
        },
      },
    );
    assert.equal(assignedWhileActive.response.status, 200);
    assert.equal(assignedWhileActive.body.agentStart.status, "started");
    assert.equal(assignedWhileActive.body.agentStart.agentKind, "claude");

    const edited = await request(
      fixture.baseUrl,
      `/api/tasks/${alreadyActive.body.task.id}`,
      {
        method: "PATCH",
        body: {
          version: assignedWhileActive.body.task.version,
          title: "An ordinary edit must not restart the agent",
        },
      },
    );
    assert.equal(edited.response.status, 200);
    assert.equal(edited.body.agentStart, undefined);
    const threads = await request(fixture.baseUrl, "/api/local/ai/threads");
    assert.equal(threads.body.threads.length, 1);
    assert.equal(threads.body.threads[0].agentKind, "claude");
  } finally {
    await fixture.close();
  }
});

test("the same in-progress transition starts the Claude assignee through its adapter", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "Automatically start Claude",
        status: "todo",
        assigneeTarget: "claude-agent",
      },
    });
    const moved = await request(
      fixture.baseUrl,
      `/api/tasks/${created.body.task.id}/move`,
      {
        method: "POST",
        body: {
          version: created.body.task.version,
          status: "in_progress",
          sortOrder: 1024,
        },
      },
    );
    assert.equal(moved.response.status, 200);
    assert.equal(moved.body.agentStart.status, "started");
    assert.equal(moved.body.agentStart.agentKind, "claude");

    let task;
    for (let index = 0; index < 100; index += 1) {
      task = await request(fixture.baseUrl, `/api/tasks/${created.body.task.id}`);
      if (task.body.task.agentSessions?.[0]?.agentKind === "claude") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(task.body.task.agentSessions.length, 1);
    assert.equal(task.body.task.agentSessions[0].agentKind, "claude");
    assert.match(task.body.task.agentSessions[0].sessionId, /^[0-9a-f-]{36}$/i);
  } finally {
    await fixture.close();
  }
});

test("danger-full-access requires confirmation on every turn and thread settings are validated", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: {
        projectId: "local",
        model: "gpt-real",
        reasoningEffort: "low",
        sandbox: "danger-full-access",
      },
    });
    assert.equal(created.response.status, 201);
    const threadId = created.body.thread.id;
    const denied = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello" },
    });
    assert.equal(denied.response.status, 400);
    assert.equal(denied.body.error.code, "DANGER_CONFIRMATION_REQUIRED");
    const allowed = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello", dangerFullAccessConfirmed: true },
    });
    assert.equal(allowed.response.status, 202);

    const invalidModel = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`, {
      method: "PATCH",
      body: { model: "invented-model", reasoningEffort: "high" },
    });
    assert.equal(invalidModel.response.status, 400);
    assert.equal(invalidModel.body.error.code, "INVALID_MODEL");
  } finally {
    await fixture.close();
  }
});

test("thread management, interrupt and query contracts stay narrow", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local", title: "Original" },
    });
    const threadId = created.body.thread.id;

    const list = await request(fixture.baseUrl, "/api/local/ai/threads");
    assert.equal(list.response.status, 200);
    assert.equal(list.body.threads.some((thread) => thread.id === threadId), true);

    const unknownQuery = await request(fixture.baseUrl, "/api/local/ai/threads?projectId=local");
    assert.equal(unknownQuery.response.status, 400);
    assert.equal(unknownQuery.body.error.code, "UNKNOWN_QUERY_PARAMETER");

    const updated = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`, {
      method: "PATCH",
      body: { title: "Renamed", sandbox: "workspace-write" },
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.thread.title, "Renamed");

    const interruptedMissing = await request(fixture.baseUrl, "/api/local/ai/runs/missing/interrupt", {
      method: "POST",
    });
    assert.equal(interruptedMissing.response.status, 404);

    const removed = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`, {
      method: "DELETE",
    });
    assert.equal(removed.response.status, 204);
    const missing = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`);
    assert.equal(missing.response.status, 404);
  } finally {
    await fixture.close();
  }
});

test("local AI routes reject private-LAN clients while ordinary API routes remain available", async (context) => {
  const address = privateLanAddress();
  if (!address) {
    context.skip("No private LAN interface is available");
    return;
  }
  const fixture = await createServerFixture("0.0.0.0");
  const port = fixture.app.server.address().port;
  try {
    const projects = await requestFrom(address, port, "/api/projects");
    assert.equal(projects.status, 200);
    const metadata = await requestFrom(address, port, "/api/meta");
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.capabilities.localAiChat, false);
    assert.equal(metadata.body.capabilities.nativeCodexTaskLaunch, false);
    const ai = await requestFrom(address, port, "/api/local/ai/threads");
    assert.equal(ai.status, 403);
    assert.equal(ai.body.error.code, "LOCAL_AI_LOOPBACK_REQUIRED");
  } finally {
    await fixture.close();
  }
});

test("AI SSE is live-only and thread snapshots remain the durable source", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local" },
    });
    const threadId = created.body.thread.id;
    const controller = new AbortController();
    const response = await fetch(`${fixture.baseUrl}/api/local/ai/threads/${threadId}/events`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let connected = "";
    while (!connected.includes("event: ai.event")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      connected += new TextDecoder().decode(chunk.value);
    }
    assert.match(connected, /connected/);
    const turn = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello" },
    });
    assert.equal(turn.response.status, 202);
    let streamed = "";
    while (!streamed.includes("ai.event")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      streamed += new TextDecoder().decode(chunk.value);
    }
    assert.match(streamed, /event: ai\.(event|run)/);
    controller.abort();
  } finally {
    await fixture.close();
  }
});

test("server close stops accepting requests before AI shutdown completes", async () => {
  const fixture = await createServerFixture();
  let appClosed = false;
  try {
    let releaseAiClose;
    const aiCloseGate = new Promise((resolve) => {
      releaseAiClose = resolve;
    });
    fixture.app.aiChat.close = () => aiCloseGate;

    const closing = fixture.app.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const acceptedDuringClose = await fetch(`${fixture.baseUrl}/health`)
      .then(() => true, () => false);
    releaseAiClose();
    await closing;
    appClosed = true;

    assert.equal(acceptedDuringClose, false);
  } finally {
    if (appClosed) {
      await rm(fixture.directory, { recursive: true, force: true });
    } else {
      await fixture.close();
    }
  }
});
