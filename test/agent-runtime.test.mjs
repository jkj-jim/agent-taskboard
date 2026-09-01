import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_RUNTIME_REASON_CODES,
  AGENT_RUNTIME_STATUSES,
  AGENT_TRANSPORTS,
  CONFIGURE_WORKBUDDY_ACTION,
  CONNECT_WORKBUDDY_ACTION,
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
  assert.equal(AGENT_RUNTIME_REASON_CODES.length, 8);
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
  assert.ok(assertRuntimeSetupAction(CONNECT_WORKBUDDY_ACTION));
  assert.equal(CONNECT_WORKBUDDY_ACTION.actionId, "connect-workbuddy-desktop");
});

test("WorkBuddy distinguishes an MCP setup problem from a disconnected desktop", async () => {
  const { createWorkbuddyAgent } = await import("../server/agents/workbuddy.mjs");
  const agent = (available, boardMcp) => createWorkbuddyAgent({
    desktopController: {
      async inspect() {
        return { available, detail: available ? "" : "9240: fetch failed" };
      },
    },
    verifyBoardMcp: async () => boardMcp,
  });

  const configured = assertAgentRuntimeStatus(
    await agent(false, { ok: true, detail: "" }).status(),
  );
  assert.equal(configured.status, "needs_setup");
  assert.equal(configured.reasonCode, "WORKBUDDY_DESKTOP_UNAVAILABLE");
  assert.equal(configured.action.actionId, "connect-workbuddy-desktop");
  assert.match(configured.statusMessage, /MCP 已连接/);

  const missing = assertAgentRuntimeStatus(
    await agent(false, { ok: false, detail: "没有登记项" }).status(),
  );
  assert.equal(missing.reasonCode, "WORKBUDDY_AUTH_REQUIRED");
  assert.equal(missing.action.actionId, "configure-workbuddy");

  const ready = assertAgentRuntimeStatus(
    await agent(true, { ok: true, detail: "" }).status(),
  );
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.transports, ["host-draft", "host-submit"]);
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

/**
 * Finder 启动的 App 只拿到 launchd 的默认 PATH（实测就是 `/usr/bin:/bin:/usr/sbin:/sbin`），
 * 而 codex 装在 /opt/homebrew/bin、claude 装在 ~/.local/bin。不补搜索目录的话，
 * 安装版会在每台机器上把「装了但找不到」报成「不可用」，而终端里跑的 dev 一切正常。
 */
test("agent CLIs stay findable under the PATH a Finder-launched app gets", async () => {
  const { agentToolDirectories, withAgentToolsOnPath } = await import(
    "../server/agents/agent-path.mjs"
  );
  const launchd = "/usr/bin:/bin:/usr/sbin:/sbin";
  const augmented = withAgentToolsOnPath({ PATH: launchd }, "/Users/somebody");

  assert.ok(augmented.PATH.startsWith(launchd), "用户自己的 PATH 必须排在最前");
  for (const directory of ["/opt/homebrew/bin", "/usr/local/bin", "/Users/somebody/.local/bin"]) {
    assert.ok(augmented.PATH.split(":").includes(directory), directory);
  }
  assert.deepEqual(
    agentToolDirectories("/Users/somebody").filter((entry) => !entry.startsWith("/")),
    [],
    "搜索目录必须是绝对路径",
  );

  // 反复包裹不该让 PATH 越接越长——状态每 10 秒探一次。
  const twice = withAgentToolsOnPath(augmented, "/Users/somebody");
  assert.equal(twice.PATH, augmented.PATH);
  // 原来就有的目录不重复追加。
  const already = withAgentToolsOnPath({ PATH: "/opt/homebrew/bin" }, "/Users/somebody");
  assert.equal(already.PATH.split(":").filter((entry) => entry === "/opt/homebrew/bin").length, 1);
});

/** 找不到 CLI 是「不可用」，不是「没测出来」——两者的恢复动作完全不同。 */
test("a missing Claude CLI reports unavailable instead of crashing the probe", async () => {
  const { createClaudeAgent } = await import("../server/agents/claude.mjs");
  const agent = createClaudeAgent({
    executable: "agent-taskboard-no-such-binary",
    processEnv: { PATH: "/nonexistent" },
  });

  const result = assertAgentRuntimeStatus(await agent.status());
  assert.equal(result.status, "unavailable");
  assert.equal(result.reasonCode, "AGENT_NOT_INSTALLED");
  assert.match(result.statusMessage, /agent-taskboard-no-such-binary/);
});

/**
 * 状态灯是「看板能不能把任务交给这个平台」，不是「本机装没装」。
 *
 * 三档要分清：客户端已接上是可用；没接上但看板能自己拉起来，也是可用（派发前
 * 会先拉起，判据是「交得出去」而不是「此刻连着」）；两者都不成立才是待配置——
 * 那时 Codex 会从负责人下拉里消失，所以只有真的交不出去才能落到这一档。
 */
test("Codex is ready whenever the board can hand it a task, connected or not", async () => {
  const { createCodexAgent } = await import("../server/agents/codex.mjs");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-home-"));
  await writeFile(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: "probe" } }),
  );
  const bridge = (supported, overrides = {}) => ({
    supported: () => supported,
    state: () => "down",
    lastError: () => null,
    ensure: async () => ({ status: "up" }),
    stop: () => {},
    ...overrides,
  });
  const agentWith = (inspectDesktop, desktopBridge = () => null) => createCodexAgent({
    executable: process.execPath,
    codexHome,
    inspectDesktop,
    desktopBridge,
  });
  const NATIVE = ["native-draft", "native-submit", "headless"];
  const offline = async () => ({
    available: false,
    reason: "没有开着调试端口的 Codex 客户端（已探测 9229）",
  });

  const connected = assertAgentRuntimeStatus(
    await agentWith(async () => ({ available: true })).status(),
  );
  assert.equal(connected.status, "ready");
  assert.deepEqual(connected.transports, NATIVE);
  assert.equal(connected.action, undefined, "已经接上就没什么要做的");

  const launchable = assertAgentRuntimeStatus(
    await agentWith(offline, () => bridge({ ok: true, reason: null })).status(),
  );
  assert.equal(launchable.status, "ready", "看板能自己拉起来就仍然交得出去");
  assert.deepEqual(launchable.transports, NATIVE);
  assert.equal(launchable.action.actionId, "connect-codex-desktop");
  assert.match(launchable.statusMessage, /自动拉起/);

  const stranded = assertAgentRuntimeStatus(
    await agentWith(offline, () => bridge({ ok: false, reason: "ChatGPT.app 不在" })).status(),
  );
  assert.equal(stranded.status, "needs_setup");
  assert.equal(stranded.reasonCode, "CODEX_DESKTOP_UNAVAILABLE");
  assert.deepEqual(stranded.transports, [], "交不出去就不该列 transport");
  // 装没装是另一回事，别把「接不上」说成「没装」，否则动作会变成下载页。
  assert.notEqual(stranded.reasonCode, "AGENT_NOT_INSTALLED");
  assert.match(stranded.statusMessage, /已探测 9229/);
  assert.match(stranded.statusMessage, /ChatGPT\.app 不在/);
  assert.equal(stranded.action.kind, "terminal-command");
  assert.equal(stranded.action.autoRunnable, false);
});

/** 已经接上时不该再准备一次；没接上时返回一个可以等的 promise，而不是当场阻塞。 */
test("Codex only prepares a launch when its client is not connected", async () => {
  const { createCodexAgent } = await import("../server/agents/codex.mjs");
  let ensured = 0;
  const desktopBridge = () => ({
    supported: () => ({ ok: true, reason: null }),
    state: () => "down",
    lastError: () => null,
    ensure: async () => { ensured += 1; return { status: "up" }; },
    stop: () => {},
  });

  const connected = createCodexAgent({
    inspectDesktop: async () => ({ available: true }),
    desktopBridge,
  });
  assert.equal(await connected.prepareLaunch(), null);
  assert.equal(ensured, 0);

  const offline = createCodexAgent({
    inspectDesktop: async () => ({ available: false }),
    desktopBridge,
  });
  const preparing = await offline.prepareLaunch();
  assert.ok(preparing.ready, "调用方要能等它");
  assert.match(preparing.message, /正在拉起/);
  assert.deepEqual(await preparing.ready, { status: "up" });
  assert.equal(ensured, 1);
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
  const { offlineCodexBridge } = await import("./helpers/agent-runtime-stub.mjs");
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexBridge: offlineCodexBridge(),
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
