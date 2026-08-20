import assert from "node:assert/strict";
import { test } from "node:test";

import { sameWorkspace, workspaceKey } from "../shared/workspace-key.mjs";

test("paths that name the same directory collapse to one key", () => {
  const base = "/Users/me/work/board";
  for (const variant of [`${base}/`, `${base}/.`, "/Users/me/work/./board", `${base}//`]) {
    assert.equal(workspaceKey(variant), workspaceKey(base), variant);
  }
});

test("case differences collapse on macOS but not on Linux", () => {
  // APFS 默认大小写不敏感，Linux 敏感；判错会让同一目录在 Codex 侧建成两个项目。
  assert.ok(sameWorkspace("/Users/me/Board", "/users/me/board", { platform: "darwin" }));
  assert.ok(!sameWorkspace("/home/me/Board", "/home/me/board", { platform: "linux" }));
});

test("macOS hands back decomposed unicode, which must still match", () => {
  // Finder 与终端给出的中文/带音标目录名字节序列不同（NFD vs NFC）。
  const composed = "/Users/me/个人/项目";
  assert.equal(workspaceKey(composed.normalize("NFD")), workspaceKey(composed));
  assert.ok(sameWorkspace("/Users/me/café", "/Users/me/café".normalize("NFD")));
});

test("a relative path is resolved rather than compared as text", () => {
  assert.equal(workspaceKey("board"), workspaceKey(`${process.cwd()}/board`));
  assert.throws(() => workspaceKey(""), /non-empty path/);
  assert.throws(() => workspaceKey(null), /non-empty path/);
});

test("different directories keep different keys", () => {
  assert.ok(!sameWorkspace("/Users/me/board", "/Users/me/board-2"));
  assert.ok(!sameWorkspace("/Users/me/board", "/Users/me/work/board"));
});

test("two projects on the same directory share one Codex project", async () => {
  const { createDeviceWorkspaces } = await import("../server/agents/workspaces.mjs");
  const deviceWorkspaces = createDeviceWorkspaces({
    codexStatePath: "/nonexistent",
    database: { listProjects: () => [] },
    // 大小写与末尾斜杠不同的同一个目录
    readProjectMappings: async () => ({ "p-1": process.cwd(), "p-2": `${process.cwd()}/` }),
  });

  const index = await deviceWorkspaces.byWorkspaceKey();
  const entries = [...index.values()];
  assert.equal(entries.length, 1, "the same directory must not appear twice");
  assert.deepEqual(entries[0].projectIds.sort(), ["p-1", "p-2"]);
});

test("the Codex launch keys its project by the directory, not by the board project id", async () => {
  const { createCodexTaskLaunchCoordinator } = await import("../server/codex-desktop-controller.mjs");
  const task = {
    id: "t-1",
    identifier: "TEST-1",
    title: "t",
    version: 1,
    projectId: "second-project",
    assignee: { type: "agent", id: "codex-agent" },
  };
  let createInput;
  const coordinator = createCodexTaskLaunchCoordinator({
    desktopController: {
      async createTask(input) {
        createInput = input;
        return { status: "prepared" };
      },
    },
    loadTask: async () => task,
    resolveWorkspace: async () => "/tmp/shared-checkout",
    resolveTaskctlShim: async () => "/tmp/taskctl",
    bindSession: async () => task,
    skillPath: "/tmp/SKILL.md",
    codexActorId: "codex-agent",
    // 两个看板项目落在同一个目录上，Codex 侧必须只用其中一个项目
    resolveCodexProjectId: async () => "first-project",
  });

  await coordinator.launch({
    taskId: task.id,
    expectedVersion: 1,
    trigger: "manual",
    presentation: "foreground",
    previousSessionId: null,
  });

  assert.equal(createInput.projectId, "first-project");
  assert.notEqual(createInput.projectId, task.projectId);
});
