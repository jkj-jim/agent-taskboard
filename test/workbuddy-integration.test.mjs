import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureMcpRegistration,
  ensureSkillInstalled,
  ensureWorkbuddyBoardAccess,
  workbuddyMcpConfigPath,
} from "../server/workbuddy-host-setup.mjs";
import {
  createWorkbuddyDesktopController,
  workbuddyTaskDeeplink,
} from "../server/workbuddy-desktop-controller.mjs";
import { createWorkbuddyTaskLaunchCoordinator } from "../server/workbuddy-task-launch.mjs";
import { agentByKind } from "../shared/agents.mjs";

const workbuddy = agentByKind("workbuddy");

async function temporaryHome() {
  return mkdtemp(path.join(os.tmpdir(), "workbuddy-home-"));
}

async function skillFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbuddy-skill-"));
  const skillPath = path.join(directory, "manage-taskboard");
  await mkdir(path.join(skillPath, "references"), { recursive: true });
  await writeFile(path.join(skillPath, "SKILL.md"), "---\nname: manage-taskboard\n---\n规则\n");
  await writeFile(path.join(skillPath, "references", "cli.md"), "参考\n");
  return skillPath;
}

test("agents table marks WorkBuddy as host-launch only with MCP board access", () => {
  assert.deepEqual(workbuddy.capabilities, {
    headless: false,
    hostLaunch: true,
    boardAccess: "mcp",
  });
  // Without a CLI there is no session env var for taskctl to recognise.
  assert.equal(workbuddy.sessionEnvVar, null);
});

test("MCP registration adds the board and leaves other servers alone", async () => {
  const homeDirectory = await temporaryHome();
  const configPath = workbuddyMcpConfigPath(homeDirectory);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    mcpServers: { other: { type: "http", url: "http://127.0.0.1:1/mcp" } },
  }));

  const first = await ensureMcpRegistration({
    origin: "http://127.0.0.1:47823",
    description: "看板",
    homeDirectory,
  });
  assert.equal(first.changed, true);
  assert.equal(first.url, "http://127.0.0.1:47823/mcp");

  const written = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(Object.keys(written.mcpServers).sort(), ["other", "taskboard"]);
  assert.equal(written.mcpServers.other.url, "http://127.0.0.1:1/mcp");
  assert.equal(written.mcpServers.taskboard.disabled, false);

  const second = await ensureMcpRegistration({
    origin: "http://127.0.0.1:47823",
    description: "看板",
    homeDirectory,
  });
  assert.equal(second.changed, false, "an unchanged registration must not rewrite the file");
});

test("an existing registration that still answers is left untouched", async () => {
  const homeDirectory = await temporaryHome();
  const configPath = workbuddyMcpConfigPath(homeDirectory);
  await mkdir(path.dirname(configPath), { recursive: true });
  const approved = {
    type: "http",
    url: "http://127.0.0.1:47900/mcp",
    description: "用户自己配的看板",
    disabled: false,
  };
  await writeFile(configPath, JSON.stringify({ mcpServers: { taskboard: approved } }));

  const result = await ensureMcpRegistration({
    origin: "http://127.0.0.1:47823",
    description: "看板",
    homeDirectory,
    probeEndpoint: async () => true,
  });

  // WorkBuddy ties trust to the configuration, so a working approved entry must
  // survive; rewriting it would silently strip the tools from the agent.
  assert.equal(result.changed, false);
  assert.equal(result.keptExisting, true);
  assert.equal(result.url, "http://127.0.0.1:47900/mcp");
  const onDisk = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(onDisk.mcpServers.taskboard, approved);
});

test("a registration that stopped answering is replaced by the live board", async () => {
  const homeDirectory = await temporaryHome();
  const configPath = workbuddyMcpConfigPath(homeDirectory);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    mcpServers: { taskboard: { type: "http", url: "http://127.0.0.1:47900/mcp", disabled: false } },
  }));

  const result = await ensureMcpRegistration({
    origin: "http://127.0.0.1:47823",
    description: "看板",
    homeDirectory,
    probeEndpoint: async () => false,
  });

  assert.equal(result.changed, true);
  assert.equal(result.url, "http://127.0.0.1:47823/mcp");
});

test("MCP registration refuses a non-http origin", async () => {
  const homeDirectory = await temporaryHome();
  await assert.rejects(
    ensureMcpRegistration({ origin: "127.0.0.1:47823", homeDirectory }),
    /http origin/,
  );
});

test("skill installation copies the whole directory and is idempotent", async () => {
  const homeDirectory = await temporaryHome();
  const skillPath = await skillFixture();

  const first = await ensureSkillInstalled({ skillPath, homeDirectory });
  assert.equal(first.changed, true);
  assert.equal(first.name, "manage-taskboard");
  assert.match(await readFile(path.join(first.path, "SKILL.md"), "utf8"), /manage-taskboard/);
  assert.equal(await readFile(path.join(first.path, "references", "cli.md"), "utf8"), "参考\n");

  const second = await ensureSkillInstalled({ skillPath, homeDirectory });
  assert.equal(second.changed, false);

  await writeFile(path.join(skillPath, "SKILL.md"), "---\nname: manage-taskboard\n---\n新规则\n");
  const third = await ensureSkillInstalled({ skillPath, homeDirectory });
  assert.equal(third.changed, true, "an edited skill must be re-synced");
});

test("board access reports whether WorkBuddy has to restart", async () => {
  const homeDirectory = await temporaryHome();
  const skillPath = await skillFixture();
  const access = await ensureWorkbuddyBoardAccess({
    origin: "http://127.0.0.1:47823",
    description: "看板",
    skillPath,
    homeDirectory,
  });
  assert.equal(access.mcp.changed, true);
  assert.equal(access.skill.changed, true);
  // A fresh registration is not yet trusted by WorkBuddy.
  assert.equal(access.requiresApproval, true);
  assert.match(access.approvalHint, /MCP 服务管理/);
});

/** Minimal CDP stand-in that answers the expressions the controller sends. */
function fakeRenderer({ states, rowVisible = true }) {
  const calls = { inserted: [], keys: [], clicks: [], evaluated: [] };
  let index = 0;
  const connection = {
    async open() {},
    close() {},
    async send(method, params) {
      if (method === "Runtime.evaluate") {
        const expression = params.expression;
        calls.evaluated.push(expression);
        if (expression.includes("aria-expanded")) return { result: { value: 0 } };
        if (expression.includes("composerReady")) {
          const state = states[Math.min(index, states.length - 1)];
          index += 1;
          return { result: { value: state } };
        }
        if (expression.includes("data-conversation-id=")) {
          return { result: { value: rowVisible ? { x: 10, y: 20 } : null } };
        }
        return { result: { value: null } };
      }
      if (method === "Input.insertText") {
        calls.inserted.push(params.text);
        return {};
      }
      if (method === "Input.dispatchKeyEvent") {
        calls.keys.push(`${params.type}:${params.key}`);
        return {};
      }
      if (method === "Input.dispatchMouseEvent") {
        calls.clicks.push(`${params.type}:${params.x},${params.y}`);
        return {};
      }
      return {};
    },
  };
  return { connection, calls };
}

function snapshot(overrides = {}) {
  return {
    composerReady: true,
    composerCenter: { x: 100, y: 200 },
    composerText: "",
    conversationIds: ["old-1"],
    running: false,
    pendingConnectorAuth: false,
    ...overrides,
  };
}

function controllerWith(renderer, options = {}) {
  const opened = [];
  const controller = createWorkbuddyDesktopController({
    fetchImplementation: async () => ({
      ok: true,
      json: async () => [{
        type: "page",
        url: "file:///Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/index.html",
        webSocketDebuggerUrl: "ws://127.0.0.1:9240/devtools/page/1",
      }],
    }),
    connect: () => renderer.connection,
    openUrl: async (url) => { opened.push(url); },
    settleMs: 0,
    ...options,
  });
  controller.opened = opened;
  return controller;
}

test("the task deep link carries the workspace and skill but never a connector", () => {
  const url = new URL(workbuddyTaskDeeplink({
    instruction: "执行任务 LOCAL-1",
    workspacePath: "/Users/me/Desktop/个人/agent-taskboard",
    skillName: "manage-taskboard",
  }));
  assert.equal(url.protocol, "workbuddy:");
  assert.equal(url.host, "task");
  assert.equal(url.searchParams.get("action"), "start");
  assert.equal(url.searchParams.get("prompt"), "执行任务 LOCAL-1");
  assert.equal(url.searchParams.get("cwd"), "/Users/me/Desktop/个人/agent-taskboard");
  assert.equal(url.searchParams.get("skills"), "manage-taskboard");
  // A connector the client cannot authorise silently blocks sending.
  assert.equal(url.searchParams.has("connectorIds"), false);
});

test("a task without a device checkout still launches, just without a cwd", () => {
  const url = new URL(workbuddyTaskDeeplink({
    instruction: "执行任务 LOCAL-2",
    workspacePath: null,
    skillName: "manage-taskboard",
  }));
  assert.equal(url.searchParams.has("cwd"), false);
  assert.equal(url.searchParams.get("skills"), "manage-taskboard");
});

test("createTask opens the deep link and submits the draft it leaves behind", async () => {
  const instruction = "执行任务 LOCAL-1";
  const renderer = fakeRenderer({
    states: [
      snapshot({ composerText: instruction }),
      snapshot({ composerText: instruction, conversationIds: ["old-1", "new-2"] }),
    ],
  });
  const controller = controllerWith(renderer);
  const result = await controller.createTask({
    instruction,
    workspacePath: "/Users/me/project",
    skillName: "manage-taskboard",
  });

  assert.equal(result.status, "started");
  assert.equal(result.sessionId, "new-2");
  assert.equal(controller.opened.length, 1);
  assert.match(controller.opened[0], /^workbuddy:\/\/task\?action=start&/);
  assert.match(controller.opened[0], /cwd=%2FUsers%2Fme%2Fproject/);
  // The deep link fills the draft, so nothing is typed into the editor.
  assert.deepEqual(renderer.calls.inserted, []);
  assert.deepEqual(renderer.calls.keys, ["keyDown:Enter", "keyUp:Enter"]);
  // A deep link leaves the composer without a caret, so Enter needs a click first.
  assert.ok(renderer.calls.clicks.some((entry) => entry.startsWith("mousePressed:")));
});

test("createTask can leave the prompt editable instead of sending it", async () => {
  const renderer = fakeRenderer({
    states: [snapshot({ composerText: "执行任务 LOCAL-2" })],
  });
  const result = await controllerWith(renderer, { prefillTimeoutMs: 2_000 }).createTask({
    instruction: "执行任务 LOCAL-2",
    submit: false,
  });
  assert.equal(result.status, "prepared");
  assert.equal(result.sessionId, null);
  assert.deepEqual(renderer.calls.keys, [], "a prepared prompt must not be submitted");
});

test("a connector waiting for authorisation is named instead of timing out", async () => {
  const instruction = "执行任务 LOCAL-3";
  const renderer = fakeRenderer({
    states: [
      snapshot({ composerText: instruction }),
      snapshot({ composerText: instruction, pendingConnectorAuth: true }),
    ],
  });
  await assert.rejects(
    controllerWith(renderer).createTask({ instruction }),
    (error) => error.code === "WORKBUDDY_CONNECTOR_UNAUTHORIZED",
  );
});

test("createTask fails loudly when the deep link never reaches the editor", async () => {
  const renderer = fakeRenderer({ states: [snapshot()] });
  await assert.rejects(
    controllerWith(renderer, { prefillTimeoutMs: 300 }).createTask({ instruction: "执行任务 X" }),
    /深链没有把任务内容填进输入框/,
  );
});

test("openSession says when a conversation row is not rendered", async () => {
  const renderer = fakeRenderer({ states: [snapshot()], rowVisible: false });
  await assert.rejects(
    controllerWith(renderer).openSession("missing-id"),
    (error) => error.code === "WORKBUDDY_SESSION_NOT_VISIBLE",
  );
});

test("inspect stays cheap and reports an unreachable client", async () => {
  const controller = createWorkbuddyDesktopController({
    fetchImplementation: async () => { throw new Error("connection refused"); },
  });
  const inspected = await controller.inspect();
  assert.equal(inspected.available, false);
  assert.equal(inspected.port, null);
  assert.match(inspected.detail, /connection refused/);
});

function launchFixture(overrides = {}) {
  const created = [];
  const bound = [];
  const access = [];
  const task = {
    id: "task-1",
    identifier: "LOCAL-7",
    title: "接入 WorkBuddy",
    version: 3,
    status: "in_progress",
    projectId: "local",
    assignee: workbuddy.actor,
    ...overrides.task,
  };
  const coordinator = createWorkbuddyTaskLaunchCoordinator({
    desktopController: {
      async createTask(input) {
        created.push(input);
        return input.submit
          ? { status: "started", sessionId: `session-${created.length}` }
          : { status: "prepared", sessionId: null };
      },
      async openSession(sessionId) {
        return { status: "opened", sessionId };
      },
    },
    loadTask: async () => task,
    bindSession: async (binding) => {
      bound.push(binding);
      return { ...task, threadId: binding.sessionId };
    },
    boardOrigin: () => "http://127.0.0.1:47823",
    skillPath: "/repo/skills/manage-taskboard",
    resolveWorkspace: overrides.resolveWorkspace ?? (async () => "/Users/me/checkout"),
    readRegistration: async () => ({ url: "http://127.0.0.1:47823/mcp", disabled: false }),
    ensureBoardAccess: async (input) => {
      access.push(input);
      return {
        mcp: { changed: false, url: "http://127.0.0.1:47823/mcp" },
        skill: { changed: false },
        requiresApproval: false,
        approvalHint: "",
      };
    },
    ...overrides.coordinator,
  });
  return { coordinator, created, bound, access, task };
}

test("launching wakes a session, binds it and registers board access once", async () => {
  const fixture = launchFixture();
  const first = await fixture.coordinator.launch({
    taskId: "task-1",
    expectedVersion: 3,
    trigger: "status-transition",
    previousSessionId: null,
  });

  assert.equal(first.status, "started");
  assert.equal(first.sessionId, "session-1");
  assert.deepEqual(fixture.bound, [{
    taskId: "task-1",
    agentKind: "workbuddy",
    sessionId: "session-1",
    previousSessionId: null,
  }]);
  assert.equal(fixture.access.length, 1);
  assert.equal(fixture.access[0].origin, "http://127.0.0.1:47823");
  assert.equal(fixture.access[0].skillPath, "/repo/skills/manage-taskboard");

  await fixture.coordinator.launch({
    taskId: "task-1",
    expectedVersion: 3,
    trigger: "manual",
    previousSessionId: null,
  });
  assert.equal(fixture.access.length, 1, "registration is idempotent per process");
});

test("a launch opens the session in the project's checkout, with the skill attached", async () => {
  const fixture = launchFixture();
  await fixture.coordinator.launch({
    taskId: "task-1",
    expectedVersion: 3,
    trigger: "status-transition",
    previousSessionId: null,
  });
  const [created] = fixture.created;
  assert.equal(created.workspacePath, "/Users/me/checkout");
  assert.equal(created.skillName, "manage-taskboard");
});

test("a project with no checkout on this device still launches", async () => {
  const fixture = launchFixture({ resolveWorkspace: async () => null });
  const result = await fixture.coordinator.launch({
    taskId: "task-1",
    expectedVersion: 3,
    trigger: "status-transition",
    previousSessionId: null,
  });
  assert.equal(result.status, "started");
  assert.equal(fixture.created[0].workspacePath, null);
});

test("the launch instruction names the task but never the board address", async () => {
  const fixture = launchFixture();
  await fixture.coordinator.launch({
    taskId: "task-1",
    expectedVersion: 3,
    trigger: "status-transition",
    previousSessionId: null,
  });
  const [{ instruction }] = fixture.created;
  assert.match(instruction, /LOCAL-7/);
  assert.match(instruction, /manage-taskboard/);
  assert.match(instruction, /get_task/);
  // WorkBuddy's gateway rejects any turn whose content carries a local URL.
  assert.doesNotMatch(instruction, /127\.0\.0\.1|localhost|http:\/\//);
});

test("a manual launch leaves the prompt editable and does not bind a session", async () => {
  const fixture = launchFixture();
  const result = await fixture.coordinator.launch({
    taskId: "task-1",
    expectedVersion: 3,
    trigger: "manual",
    previousSessionId: null,
  });
  assert.equal(result.status, "prepared");
  assert.equal(fixture.created[0].submit, false);
  assert.deepEqual(fixture.bound, []);
});

test("launching refuses a stale version, a foreign assignee and a wrong state", async () => {
  const stale = launchFixture();
  await assert.rejects(
    stale.coordinator.launch({
      taskId: "task-1",
      expectedVersion: 2,
      trigger: "status-transition",
      previousSessionId: null,
    }),
    (error) => error.code === "VERSION_CONFLICT" && error.details.actualVersion === 3,
  );

  const foreign = launchFixture({
    task: { assignee: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null } },
  });
  await assert.rejects(
    foreign.coordinator.launch({
      taskId: "task-1",
      expectedVersion: 3,
      trigger: "status-transition",
      previousSessionId: null,
    }),
    (error) => error.code === "WORKBUDDY_NOT_ASSIGNED",
  );

  const todo = launchFixture({ task: { status: "todo" } });
  await assert.rejects(
    todo.coordinator.launch({
      taskId: "task-1",
      expectedVersion: 3,
      trigger: "status-transition",
      previousSessionId: null,
    }),
    (error) => error.code === "INVALID_AGENT_LAUNCH_STATE",
  );
});

test("concurrent status-transition launches share one session", async () => {
  const fixture = launchFixture();
  const [a, b] = await Promise.all([
    fixture.coordinator.launch({
      taskId: "task-1",
      expectedVersion: 3,
      trigger: "status-transition",
      previousSessionId: null,
    }),
    fixture.coordinator.launch({
      taskId: "task-1",
      expectedVersion: 3,
      trigger: "status-transition",
      previousSessionId: null,
    }),
  ]);
  assert.equal(a.sessionId, b.sessionId);
  assert.equal(fixture.created.length, 1, "a double trigger must not start two sessions");
});

test("launching refuses while the board's MCP server is disabled", async () => {
  const fixture = launchFixture({
    coordinator: { readRegistration: async () => ({ url: "http://127.0.0.1:47823/mcp", disabled: true }) },
  });
  await assert.rejects(
    fixture.coordinator.launch({
      taskId: "task-1",
      expectedVersion: 3,
      trigger: "status-transition",
      previousSessionId: null,
    }),
    (error) => error.code === "WORKBUDDY_BOARD_ACCESS_DISABLED"
      && /MCP 服务管理/.test(error.message),
  );
  // The point of refusing early is not spending a turn on a doomed launch.
  assert.deepEqual(fixture.created, []);
  assert.deepEqual(fixture.bound, []);
});

test("an idle connection is not treated as a broken link", async () => {
  // WorkBuddy's proxy connects lazily and closes again, so only the enabled
  // registration is a valid precondition.
  const fixture = launchFixture({
    coordinator: { readRegistration: async () => ({ url: "http://127.0.0.1:47823/mcp", disabled: false }) },
  });
  const result = await fixture.coordinator.launch({
    taskId: "task-1",
    expectedVersion: 3,
    trigger: "status-transition",
    previousSessionId: null,
  });
  assert.equal(result.status, "started");
});
