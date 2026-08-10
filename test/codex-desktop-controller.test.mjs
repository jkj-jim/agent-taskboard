import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  createCodexTaskLaunchCoordinator,
} from "../server/codex-desktop-controller.mjs";
import { codexDebuggingPorts, codexTargets } from "../shared/codex-cdp.mjs";

const CODEX_ACTOR_ID = "codex-agent";

function task(id, version = 1) {
  return {
    id,
    identifier: `TEST-${id}`,
    title: `Task title ${id}`,
    projectId: "project",
    status: "in_progress",
    version,
    threadId: null,
    assignee: { type: "agent", id: CODEX_ACTOR_ID },
  };
}

function launchInput(taskId) {
  return {
    taskId,
    expectedVersion: 1,
    trigger: "status-transition",
    presentation: "background",
    previousSessionId: null,
  };
}

function manualLaunchInput(taskId) {
  return {
    taskId,
    expectedVersion: 1,
    trigger: "manual",
    presentation: "foreground",
    previousSessionId: null,
  };
}

test("Codex CDP discovery only reads existing ChatGPT/Codex debug ports", () => {
  assert.deepEqual(codexDebuggingPorts(9229, [
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=9231",
    "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9232",
    "/Applications/Other.app/Contents/MacOS/Other --remote-debugging-port=9999",
  ].join("\n")), [9229, 9231, 9232]);
});

test("Codex target discovery excludes auxiliary initial-route windows", async () => {
  const targets = await codexTargets(9231, async () => ({
    ok: true,
    json: async () => [
      {
        id: "main",
        type: "page",
        title: "Codex",
        url: "app://-/index.html",
        webSocketDebuggerUrl: "ws://127.0.0.1:9231/devtools/page/main",
      },
      {
        id: "avatar",
        type: "page",
        title: "Codex",
        url: "app://-/index.html?initialRoute=%2Favatar-overlay",
        webSocketDebuggerUrl: "ws://127.0.0.1:9231/devtools/page/avatar",
      },
      {
        id: "dictation",
        type: "page",
        title: "Codex",
        url: "app://-/index.html?initialRoute=%2Fglobal-dictation",
        webSocketDebuggerUrl: "ws://127.0.0.1:9231/devtools/page/dictation",
      },
    ],
  }));

  assert.deepEqual(targets.map((target) => target.id), ["main"]);
});

test("native task capture resolves the canonical conversation id behind optimistic sidebar ids", async () => {
  const source = await readFile(new URL("../server/codex-desktop-controller.mjs", import.meta.url), "utf8");
  assert.match(source, /client-new-thread|__reactFiber\$/);
  assert.match(source, /props\?\.conversationId/);
  assert.match(source, /knownSidebarRowIds/);
  assert.match(source, /createdSidebarRowId/);
  assert.match(source, /CODEX_THREAD_ID\.test\(value\) && !knownThreadIds\.has\(value\)/);
});

test("native task creation renames the new Codex chat from the task title without an AI turn", async () => {
  const source = await readFile(new URL("../server/codex-desktop-controller.mjs", import.meta.url), "utf8");
  assert.match(source, /async function renameNativeThread\(cdp, threadId, title\)/);
  assert.match(source, /data-thread-title/);
  assert.match(source, /conversationId\(candidate\) === \$\{escapedThreadId\}/);
  assert.match(source, /tooltipContent\?\.props\?\.children\?\.props\?\.conversationId/);
  assert.doesNotMatch(source, /replace\(\/\^\(\?:local\|cloud\):\(\?:client-new-thread:/);
  assert.match(source, /input\[aria-label=.*聊天标题/);
  assert.match(source, /Codex native chat title was not accepted/);
  assert.match(source, /!button\.disabled/);
  assert.match(source, /title: task\.title/);
  assert.match(source, /await renameNativeThread\(cdp, sessionId, title\)/);
});

test("native launch readiness separates the live injector from the post-navigation composer", async () => {
  const source = await readFile(new URL("../server/codex-desktop-controller.mjs", import.meta.url), "utf8");
  assert.match(source, /compatible: apiReady && hostBindingReady && heartbeatFresh && bridgeReady && sidebarReady/);
  assert.match(source, /composerReady/);
  assert.doesNotMatch(source, /compatible:[^\n]*composerReady/);
  assert.match(source, /Taskboard 注入器心跳已停止/);
  assert.match(source, /await navigate\(cdp, "\/"\)/);
  assert.match(source, /Codex new-task composer did not become ready/);
});

test("native task creation is process-serialized across different issues", async () => {
  const tasks = new Map([["one", task("one")], ["two", task("two")]]);
  const releases = [];
  let active = 0;
  let maximumActive = 0;
  let sequence = 0;
  const coordinator = createCodexTaskLaunchCoordinator({
    desktopController: {
      async createTask() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => releases.push(resolve));
        active -= 1;
        sequence += 1;
        return {
          status: "started",
          sessionId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
        };
      },
    },
    loadTask: (id) => tasks.get(id),
    resolveWorkspace: async () => "/tmp/project",
    resolveTaskctlShim: async () => "/tmp/taskboard/bin/taskctl",
    bindSession: async (binding) => ({
      ...tasks.get(binding.taskId),
      version: 2,
      threadId: binding.sessionId,
    }),
    skillPath: "/tmp/manage-taskboard/SKILL.md",
    codexActorId: CODEX_ACTOR_ID,
  });

  const first = coordinator.launch(launchInput("one"));
  while (releases.length < 1) await new Promise((resolve) => setImmediate(resolve));
  const second = coordinator.launch(launchInput("two"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  assert.equal(releases.length, 1);
  releases.shift()();
  while (releases.length < 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  releases.shift()();
  await Promise.all([first, second]);
  assert.equal(maximumActive, 1);
});

test("a failed writeback retries the cached native task without creating a duplicate", async () => {
  const current = task("retry");
  let createCount = 0;
  let bindCount = 0;
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const coordinator = createCodexTaskLaunchCoordinator({
    desktopController: {
      async createTask() {
        createCount += 1;
        return { status: "started", sessionId };
      },
    },
    loadTask: async () => current,
    resolveWorkspace: async () => "/tmp/project",
    resolveTaskctlShim: async () => "/tmp/taskboard/bin/taskctl",
    bindSession: async () => {
      bindCount += 1;
      if (bindCount === 1) throw new Error("temporary writeback failure");
      return { ...current, version: 2, threadId: sessionId };
    },
    skillPath: "/tmp/manage-taskboard/SKILL.md",
    codexActorId: CODEX_ACTOR_ID,
  });

  await assert.rejects(coordinator.launch(launchInput("retry")), /temporary writeback failure/);
  const retried = await coordinator.launch(launchInput("retry"));
  assert.equal(retried.sessionId, sessionId);
  assert.equal(createCount, 1);
  assert.equal(bindCount, 2);
});

test("automatic native launch revalidates status and Codex assignment", async () => {
  const invalid = { ...task("invalid"), status: "todo" };
  let createCount = 0;
  const coordinator = createCodexTaskLaunchCoordinator({
    desktopController: {
      async createTask() {
        createCount += 1;
        return {
          status: "started",
          sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        };
      },
    },
    loadTask: async () => invalid,
    resolveWorkspace: async () => "/tmp/project",
    resolveTaskctlShim: async () => "/tmp/taskboard/bin/taskctl",
    bindSession: async () => invalid,
    skillPath: "/tmp/manage-taskboard/SKILL.md",
    codexActorId: CODEX_ACTOR_ID,
  });

  await assert.rejects(
    coordinator.launch(launchInput("invalid")),
    (error) => error.code === "INVALID_AGENT_LAUNCH_STATE",
  );
  assert.equal(createCount, 0);
});

test("native task instructions use the absolute taskctl shim for the whole turn", async () => {
  const current = task("quoted");
  let createInput;
  const coordinator = createCodexTaskLaunchCoordinator({
    desktopController: {
      async createTask(input) {
        createInput = input;
        return {
          status: "started",
          sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        };
      },
    },
    loadTask: async () => current,
    resolveWorkspace: async () => "/tmp/project",
    resolveTaskctlShim: async () => "/tmp/taskboard's bin/taskctl",
    bindSession: async () => ({ ...current, version: 2 }),
    skillPath: "/tmp/manage-taskboard/SKILL.md",
    codexActorId: CODEX_ACTOR_ID,
  });

  await coordinator.launch(launchInput("quoted"));

  assert.match(createInput.instruction, /^处理任务 TEST-quoted。/);
  assert.match(createInput.instruction, /每一次 Taskboard 操作都使用/);
  assert.match(
    createInput.instruction,
    /先运行 '\/tmp\/taskboard'\\''s bin\/taskctl' issue brief 'TEST-quoted' --json。$/,
  );
  assert.equal(createInput.title, current.title);
  assert.ok(createInput.instruction.length <= 1_024);
});

test("native task launch rejects instructions over the injector limit", async () => {
  const current = task("long");
  let createCount = 0;
  const coordinator = createCodexTaskLaunchCoordinator({
    desktopController: {
      async createTask() {
        createCount += 1;
        return {
          status: "started",
          sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        };
      },
    },
    loadTask: async () => current,
    resolveWorkspace: async () => "/tmp/project",
    resolveTaskctlShim: async () => `/tmp/${"x".repeat(600)}/taskctl`,
    bindSession: async () => current,
    skillPath: "/tmp/manage-taskboard/SKILL.md",
    codexActorId: CODEX_ACTOR_ID,
  });

  await assert.rejects(
    coordinator.launch(launchInput("long")),
    (error) => error.code === "CODEX_INSTRUCTION_TOO_LONG",
  );
  assert.equal(createCount, 0);
});

test("manual native launch only prepares an editable prompt and is repeatable", async () => {
  const current = task("manual");
  let createCount = 0;
  let bindCount = 0;
  const presentations = [];
  const coordinator = createCodexTaskLaunchCoordinator({
    desktopController: {
      async createTask(input) {
        createCount += 1;
        presentations.push(input.presentation);
        return { status: "prepared" };
      },
    },
    loadTask: async () => current,
    resolveWorkspace: async () => "/tmp/project",
    resolveTaskctlShim: async () => "/tmp/taskboard/bin/taskctl",
    bindSession: async () => {
      bindCount += 1;
      return current;
    },
    skillPath: "/tmp/manage-taskboard/SKILL.md",
    codexActorId: CODEX_ACTOR_ID,
  });

  const first = await coordinator.launch(manualLaunchInput("manual"));
  const second = await coordinator.launch(manualLaunchInput("manual"));

  assert.equal(first.status, "prepared");
  assert.equal(first.task.version, current.version);
  assert.equal(second.status, "prepared");
  assert.equal(createCount, 2);
  assert.equal(bindCount, 0);
  assert.deepEqual(presentations, ["foreground", "foreground"]);
});
