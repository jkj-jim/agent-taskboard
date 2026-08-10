import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findResidentInjectorPids,
  handleHostBindingPayload,
  maintainHostHeartbeats,
  reconcileInjectionRuntime,
  waitForStableTargetSet,
} from "../scripts/codex-injector-runtime.mjs";

const currentAutomationRequest = {
  id: "host-request-1",
  action: "automation",
  requestId: "automation-request-1",
  operation: "ensure-active",
  taskboardProjectId: "local",
  codexProjectId: "codex-project",
  projectName: "Local",
  workspacePath: "/tmp/project",
  skillPath: "/tmp/manage-taskboard/SKILL.md",
  intervalMinutes: 10,
  model: "gpt-5.6-sol",
  reasoningEffort: "ultra",
};

test("a stale automation parser receives an immediate host error instead of timing out", async () => {
  const responses = [];
  const staleParser = () => null;

  const result = await Promise.race([
    handleHostBindingPayload(
      {
        payload: JSON.stringify(currentAutomationRequest),
        executionContextId: 12,
      },
      {
        parseAutomationRequest: staleParser,
        ensure: async () => assert.fail("ensure must not run"),
        runAutomation: async () => assert.fail("automation must not run"),
        prefill: async () => assert.fail("prefill must not run"),
        sendResponse: async (_executionContextId, response) => responses.push(response),
      },
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error("host response timed out")), 50)),
  ]);

  assert.deepEqual(result, { responded: true, accepted: false });
  assert.deepEqual(responses, [{
    id: currentAutomationRequest.id,
    ok: false,
    error: "自动认领配置暂时无法应用，请刷新后重试",
    diagnosticCode: "AUTOMATION_SCHEMA_MISMATCH",
  }]);
});

test("attach replaces an old runtime with the current source and restores an open page", async () => {
  const calls = [];
  const result = await reconcileInjectionRuntime({
    currentStatus: {
      version: "0.6.7",
      sourceHash: null,
      pageVisible: true,
      scriptIdentifier: "old-registration",
    },
    source: "current-source",
    sourceHash: "current-hash",
    removeRegisteredSource: async (identifier) => calls.push(["remove", identifier]),
    registerCurrentSource: async (source) => {
      calls.push(["register", source]);
      return "current-registration";
    },
    evaluateCurrentSource: async (source) => calls.push(["evaluate", source]),
    publishRegistration: async (identifier) => calls.push(["publish", identifier]),
    reopen: async () => calls.push(["open"]),
  });

  assert.deepEqual(result, {
    replaced: true,
    scriptIdentifier: "current-registration",
    shouldRemainOpen: true,
  });
  assert.deepEqual(calls, [
    ["remove", "old-registration"],
    ["register", "current-source"],
    ["evaluate", "current-source"],
    ["publish", "current-registration"],
    ["open"],
  ]);
});

test("attach is idempotent for the same source hash and does not open a closed page", async () => {
  const calls = [];
  const result = await reconcileInjectionRuntime({
    currentStatus: {
      version: "0.6.8",
      sourceHash: "current-hash",
      pageVisible: false,
      scriptIdentifier: "old-registration",
    },
    source: "current-source",
    sourceHash: "current-hash",
    removeRegisteredSource: async (identifier) => calls.push(["remove", identifier]),
    registerCurrentSource: async (source) => {
      calls.push(["register", source]);
      return "current-registration";
    },
    evaluateCurrentSource: async (source) => calls.push(["evaluate", source]),
    publishRegistration: async (identifier) => calls.push(["publish", identifier]),
    reopen: async () => calls.push(["open"]),
  });

  assert.deepEqual(result, {
    replaced: false,
    scriptIdentifier: "current-registration",
    shouldRemainOpen: false,
  });
  assert.deepEqual(calls, [
    ["remove", "old-registration"],
    ["register", "current-source"],
    ["evaluate", "current-source"],
    ["publish", "current-registration"],
  ]);
});

test("a stalled CDP heartbeat is evicted without blocking the resident loop", async () => {
  const healthy = { id: "healthy" };
  const stalled = { id: "stalled" };
  const evicted = [];
  const failures = await maintainHostHeartbeats({
    connections: [["main", healthy], ["old-renderer", stalled]],
    publish: async (connection) => {
      if (connection === stalled) await new Promise(() => {});
    },
    evict: async (targetId, connection, error) => {
      evicted.push([targetId, connection, error.message]);
    },
    timeoutMs: 10,
  });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].targetId, "old-renderer");
  assert.deepEqual(evicted, [[
    "old-renderer",
    stalled,
    "CDP heartbeat timed out after 10 ms",
  ]]);
});

test("initial injection waits for the same renderer target set to remain stable", async () => {
  let currentTime = 0;
  let discoveryCount = 0;
  const snapshots = [
    [],
    [{ id: "renderer-a" }],
    [{ id: "renderer-b" }],
    [{ id: "renderer-b" }],
    [{ id: "renderer-b" }],
  ];

  const targets = await waitForStableTargetSet({
    discover: async () => snapshots[Math.min(discoveryCount++, snapshots.length - 1)],
    timeoutMs: 1_000,
    stableMs: 200,
    pollIntervalMs: 100,
    now: () => currentTime,
    sleep: async (delayMs) => {
      currentTime += delayMs;
    },
  });

  assert.deepEqual(targets, [{ id: "renderer-b" }]);
  assert.equal(discoveryCount, 5);
});

test("initial injection reports a bounded timeout when no renderer stabilizes", async () => {
  let currentTime = 0;
  await assert.rejects(
    waitForStableTargetSet({
      discover: async () => [],
      timeoutMs: 300,
      stableMs: 200,
      pollIntervalMs: 100,
      now: () => currentTime,
      sleep: async (delayMs) => {
        currentTime += delayMs;
      },
    }),
    /Timed out after 300 ms waiting for a stable Codex renderer/,
  );
});

test("resident discovery accepts this repository's absolute and relative launch forms only", () => {
  const projectRoot = "/workspace/codex-taskboard";
  const injectorPath = `${projectRoot}/scripts/codex-injector.mjs`;
  const processList = [
    `101 node ${injectorPath} --watch --port 9231`,
    "102 node scripts/codex-injector.mjs --watch",
    "103 node ./scripts/codex-injector.mjs --watch --port=9231",
    "104 node scripts/codex-injector.mjs --watch",
    `105 node ${injectorPath} --watch --port 9229`,
    `106 node ${injectorPath} --port 9231`,
  ].join("\n");
  const cwdByPid = new Map([
    [102, projectRoot],
    [103, projectRoot],
    [104, "/workspace/another-repository"],
  ]);

  assert.deepEqual(findResidentInjectorPids({
    processList,
    currentPid: 999,
    injectorPath,
    projectRoot,
    port: 9231,
    defaultPort: 9229,
    cwdForPid: (pid) => cwdByPid.get(pid) ?? null,
  }), [101, 103]);
  assert.deepEqual(findResidentInjectorPids({
    processList,
    currentPid: 999,
    injectorPath,
    projectRoot,
    port: 9229,
    defaultPort: 9229,
    cwdForPid: (pid) => cwdByPid.get(pid) ?? null,
  }), [102, 105]);
});
