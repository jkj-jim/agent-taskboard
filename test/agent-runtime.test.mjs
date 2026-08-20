import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_RUNTIME_REASON_CODES,
  AGENT_RUNTIME_STATUSES,
  AGENT_TRANSPORTS,
  CONFIGURE_WORKBUDDY_ACTION,
  assertAgentRuntimeStatus,
  assertRuntimeSetupAction,
  unknownRuntimeStatus,
} from "../shared/agent-runtime.mjs";
import {
  INTERACTIVE_WAIT_MS,
  createAgentRuntimeStatuses,
} from "../server/agents/runtime-status.mjs";

function registryOf(agents) {
  return {
    list: () => agents,
    get: (kind) => {
      const agent = agents.find((candidate) => candidate.id === kind);
      if (!agent) throw new Error(`Unknown agent '${kind}'`);
      return agent;
    },
  };
}

function stubAgent(id, status) {
  const agent = { id, label: id, calls: 0, status: async () => {
    agent.calls += 1;
    return status(agent.calls);
  } };
  return agent;
}

test("the runtime vocabulary is the one the design fixes", () => {
  assert.deepEqual(AGENT_TRANSPORTS, [
    "native-draft",
    "native-submit",
    "host-draft",
    "host-submit",
    "headless",
  ]);
  assert.deepEqual(AGENT_RUNTIME_STATUSES, [
    "ready",
    "needs_auth",
    "needs_setup",
    "unavailable",
    "unknown",
  ]);
  assert.equal(AGENT_RUNTIME_REASON_CODES.length, 6);
});

test("setup actions outside the allowlist are rejected", () => {
  // 一期不引导下载，external-url 的 allowlist 是空的：任何 URL 都进不来。
  assert.throws(
    () => assertRuntimeSetupAction({
      kind: "external-url",
      label: "x",
      message: "x",
      autoRunnable: true,
      url: "https://example.com/malware",
    }),
    /preset download page/,
  );
  assert.throws(
    () => assertRuntimeSetupAction({
      kind: "app-action",
      label: "x",
      message: "x",
      autoRunnable: true,
      actionId: "run-anything",
    }),
    /Unknown app action/,
  );
  assert.throws(
    () => assertRuntimeSetupAction({
      kind: "internal-route",
      label: "x",
      message: "x",
      autoRunnable: true,
      route: "/etc/passwd",
    }),
    /Unknown internal route/,
  );
  // 终端命令永远只展示，不允许被标成可自动执行
  assert.throws(
    () => assertRuntimeSetupAction({
      kind: "terminal-command",
      label: "x",
      message: "x",
      autoRunnable: true,
      command: "rm -rf /",
    }),
    /must not be auto-runnable/,
  );
  // WorkBuddy 的配置动作必须在 allowlist 内
  assert.ok(assertRuntimeSetupAction(CONFIGURE_WORKBUDDY_ACTION));
  assert.equal(CONFIGURE_WORKBUDDY_ACTION.actionId, "configure-workbuddy");
});

test("a runtime status with an unknown transport or reason code is rejected", () => {
  assert.throws(
    () => assertAgentRuntimeStatus({ status: "ready", transports: ["telepathy"] }),
    /Unknown agent transport/,
  );
  assert.throws(
    () => assertAgentRuntimeStatus({ status: "great", transports: [] }),
    /Unknown agent runtime status/,
  );
  assert.throws(
    () => assertAgentRuntimeStatus({ status: "ready", transports: [], reasonCode: "NOPE" }),
    /Unknown agent runtime reason code/,
  );
  assert.ok(assertAgentRuntimeStatus(unknownRuntimeStatus("探测超时")));
});

test("results are cached per agent for the TTL and forced refreshes bypass it", async () => {
  let clock = 0;
  const agent = stubAgent("codex", (calls) => ({ status: "ready", transports: [], version: `v${calls}` }));
  const statuses = createAgentRuntimeStatuses({
    registry: registryOf([agent]),
    ttlMs: 10_000,
    now: () => clock,
  });

  assert.equal((await statuses.get("codex")).version, "v1");
  clock = 9_999;
  assert.equal((await statuses.get("codex")).version, "v1", "still inside the TTL");
  assert.equal(statuses.hasFresh("codex"), true);

  clock = 10_000;
  assert.equal(statuses.hasFresh("codex"), false);
  assert.equal((await statuses.get("codex")).version, "v2", "TTL expired");

  assert.equal((await statuses.get("codex", { force: true })).version, "v3");
  assert.equal(agent.calls, 3);
});

test("concurrent probes of one agent collapse into a single run", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const agent = stubAgent("codex", async () => {
    await gate;
    return { status: "ready", transports: [] };
  });
  const statuses = createAgentRuntimeStatuses({ registry: registryOf([agent]) });

  const all = Promise.all([statuses.get("codex"), statuses.get("codex"), statuses.get("codex")]);
  release();
  const results = await all;

  assert.equal(agent.calls, 1);
  assert.equal(results.every((result) => result.status === "ready"), true);
});

test("a timed-out interactive probe reuses the last result and marks it stale", async () => {
  let hang = false;
  const agent = stubAgent("claude", async () => {
    if (hang) await new Promise(() => {});
    return { status: "ready", transports: ["headless"] };
  });
  let clock = 0;
  const statuses = createAgentRuntimeStatuses({
    registry: registryOf([agent]),
    ttlMs: 1,
    now: () => clock,
  });

  const first = await statuses.get("claude");
  assert.equal(first.stale, false);

  hang = true;
  clock = 10_000;
  const second = await statuses.forInteraction("claude");
  assert.equal(second.status, "ready", "the previous verdict is reused");
  assert.equal(second.stale, true);
  assert.equal(second.checkedAt, first.checkedAt, "stale results keep the old timestamp");
});

test("with no previous result a failed probe is unknown, never unavailable", async () => {
  const agent = stubAgent("workbuddy", () => {
    throw new Error("boom");
  });
  const statuses = createAgentRuntimeStatuses({ registry: registryOf([agent]) });

  const result = await statuses.get("workbuddy");
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, "AGENT_STATUS_UNKNOWN");
  assert.deepEqual(result.transports, []);
  assert.equal(result.stale, false, "this verdict is about this probe, not a reused one");
  assert.equal(result.action.actionId, "refresh-agent-status");
});

test("the interactive wait is the short one the design fixes", () => {
  assert.equal(INTERACTIVE_WAIT_MS, 1_500);
});

test("every agent result carries the fields the endpoint promises", async () => {
  const statuses = createAgentRuntimeStatuses({
    registry: registryOf([
      stubAgent("codex", () => ({ status: "ready", transports: ["headless"] })),
      stubAgent("claude", () => ({
        status: "needs_auth",
        transports: [],
        reasonCode: "CLAUDE_AUTH_REQUIRED",
        statusMessage: "未登录",
        action: {
          kind: "terminal-command",
          label: "复制登录命令",
          message: "在终端里运行",
          autoRunnable: false,
          command: "claude auth login",
        },
      })),
    ]),
  });

  const [codex, claude] = await statuses.list();
  assert.deepEqual(Object.keys(codex).sort(), ["checkedAt", "kind", "stale", "status", "transports"]);
  assert.equal(claude.action.kind, "terminal-command");
  assert.equal(claude.action.autoRunnable, false);
  assert.match(claude.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("the endpoint returns runtime status only, and the assignee gate uses it", async () => {
  const { createTaskboardServer } = await import("../server/index.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-runtime-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    agentRuntimeStatuses: createAgentRuntimeStatuses({
      registry: registryOf([
        stubAgent("codex", () => ({ status: "ready", transports: ["headless"] })),
        stubAgent("claude", () => ({
          status: "needs_auth",
          transports: [],
          reasonCode: "CLAUDE_AUTH_REQUIRED",
          statusMessage: "Claude Code CLI 未登录。",
        })),
        stubAgent("workbuddy", () => {
          throw new Error("unreachable");
        }),
      ]),
    }),
  });
  const address = await app.listen({ port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "local", name: "Local" }),
    });

    const snapshot = await fetch(`${baseUrl}/api/local/agents`).then((r) => r.json());
    assert.equal(snapshot.defaultAgentKind, "codex");
    // 静态的名称、图标由 Web 从 shared/agents.mjs 合并，endpoint 不再带旧字段
    for (const agent of snapshot.agents) {
      assert.equal("label" in agent, false);
      assert.equal("available" in agent, false);
      assert.equal("authenticated" in agent, false);
      assert.equal("detail" in agent, false);
    }
    assert.equal(snapshot.agents.find((a) => a.kind === "workbuddy").status, "unknown");

    const createWith = (assigneeTarget) => fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "local", title: "t", assigneeTarget }),
    });

    assert.equal((await createWith("codex-agent")).status, 201, "ready agents are assignable");
    // 未登录是明确结论，拦下
    const rejected = await createWith("claude-agent");
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error.code, "AGENT_NOT_READY");
    // unknown 不等于不可用，不能因为「这次没测出来」就挡住保存
    assert.equal((await createWith("workbuddy-agent")).status, 201);
    assert.equal((await createWith("current-user")).status, 201);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
