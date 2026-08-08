import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  createCodexTaskLaunchCoordinator,
} from "../server/codex-desktop-controller.mjs";
import { codexDebuggingPorts } from "../shared/codex-cdp.mjs";

const CODEX_ACTOR_ID = "codex-agent";

function task(id, version = 1) {
  return {
    id,
    identifier: `TEST-${id}`,
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

test("Codex CDP discovery only reads existing ChatGPT/Codex debug ports", () => {
  assert.deepEqual(codexDebuggingPorts(9229, [
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=9231",
    "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9232",
    "/Applications/Other.app/Contents/MacOS/Other --remote-debugging-port=9999",
  ].join("\n")), [9229, 9231, 9232]);
});

test("native task capture resolves the canonical conversation id behind optimistic sidebar ids", async () => {
  const source = await readFile(new URL("../server/codex-desktop-controller.mjs", import.meta.url), "utf8");
  assert.match(source, /client-new-thread|__reactFiber\$/);
  assert.match(source, /props\?\.conversationId/);
  assert.match(source, /knownSidebarRowIds/);
  assert.match(source, /createdSidebarRowId/);
  assert.match(source, /CODEX_THREAD_ID\.test\(value\) && !knownThreadIds\.has\(value\)/);
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
        return { sessionId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}` };
      },
    },
    loadTask: (id) => tasks.get(id),
    resolveWorkspace: async () => "/tmp/project",
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
        return { sessionId };
      },
    },
    loadTask: async () => current,
    resolveWorkspace: async () => "/tmp/project",
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
        return { sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
      },
    },
    loadTask: async () => invalid,
    resolveWorkspace: async () => "/tmp/project",
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
