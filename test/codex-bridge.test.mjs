import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createCodexBridge } from "../server/codex-bridge.mjs";
import { createAgentLaunchCoordinator } from "../server/agents/launch.mjs";

/** 真的去 spawn 会拉起 Codex；这里只验编排，注入器换成一个立刻退出的脚本。 */
async function fixture({ injector = "process.exit(0)", appPath, connected = [] } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-"));
  const injectorPath = path.join(directory, "injector.mjs");
  await writeFile(injectorPath, injector);
  const application = appPath ?? path.join(directory, "ChatGPT.app");
  if (appPath === undefined) await writeFile(application, "");
  const inspected = [];
  const controller = {
    inspect: async () => {
      const available = connected[Math.min(inspected.length, connected.length - 1)] ?? false;
      inspected.push(available);
      return { available };
    },
  };
  return { directory, injectorPath, application, controller, inspected };
}

test("an unbundled injector or a missing client is reported, never launched blindly", async () => {
  const { controller, application } = await fixture();

  const unbundled = createCodexBridge({
    controller,
    injectorPath: path.join(os.tmpdir(), "definitely-not-here.mjs"),
    appPath: application,
  });
  assert.equal(unbundled.supported().ok, false);
  assert.match(unbundled.supported().reason, /没有随包携带/);
  await assert.rejects(unbundled.ensure(), /没有随包携带/);

  const uninstalled = createCodexBridge({
    controller,
    injectorPath: application,
    appPath: path.join(os.tmpdir(), "no-such-client.app"),
  });
  assert.equal(uninstalled.supported().ok, false);
  assert.match(uninstalled.supported().reason, /没有安装/);
});

test("an already connected client is reused instead of launching a second one", async () => {
  const { controller, injectorPath, application } = await fixture({ connected: [true] });
  const bridge = createCodexBridge({ controller, injectorPath, appPath: application });

  assert.deepEqual(await bridge.ensure(), { status: "up", launched: false });
  assert.equal(bridge.state(), "down", "没有子进程要养");
});

test("an injector that dies before the client connects fails loudly", async () => {
  const { controller, injectorPath, application } = await fixture({
    injector: 'process.stderr.write("Codex CDP is not listening\\n"); process.exit(1);',
    connected: [false],
  });
  const bridge = createCodexBridge({
    controller,
    injectorPath,
    appPath: application,
    pollIntervalMs: 20,
    readyTimeoutMs: 5_000,
  });

  await assert.rejects(bridge.ensure(), /注入器退出了.*not listening/s);
  assert.ok(bridge.lastError(), "失败原因要留下来，状态区靠它解释");
});

test("concurrent ensures share one launch", async () => {
  const { controller, injectorPath, application } = await fixture({
    injector: "setTimeout(() => {}, 60_000)",
    connected: [false, false, true],
  });
  const bridge = createCodexBridge({
    controller,
    injectorPath,
    appPath: application,
    pollIntervalMs: 20,
    readyTimeoutMs: 5_000,
  });

  const [first, second] = await Promise.all([bridge.ensure(), bridge.ensure()]);
  assert.deepEqual(first, second);
  assert.equal(first.status, "up");
  bridge.stop();
});

/**
 * 冷启动要二三十秒，不能把「拖进进行中」卡在那里：先接受这次请求并回 preparing，
 * 客户端就绪后由服务端自己补派发一次，而且要用任务的当前版本，不是等待前那个。
 */
test("a launch that needs its client prepared is deferred, then redispatched", async () => {
  let ready;
  const gate = new Promise((resolve) => { ready = resolve; });
  const prepared = [];
  const native = [];
  const agent = {
    id: "codex",
    label: "Codex",
    actor: { id: "codex-agent" },
    prepareLaunch: async () => {
      prepared.push(Date.now());
      return prepared.length === 1 ? { message: "正在拉起 Codex。", ready: gate } : null;
    },
  };
  const deferred = [];
  const coordinator = createAgentLaunchCoordinator({
    registry: { list: () => [agent] },
    runtimeStatuses: {
      forInteraction: async () => ({
        status: "ready",
        transports: ["native-submit"],
        stale: false,
      }),
    },
    runNative: async ({ expectedVersion }) => {
      native.push(expectedVersion);
      return { status: "started", sessionId: "session-1" };
    },
    // 等待期间任务被别人改过：补派发必须用当前版本，否则一定撞 CAS。
    reloadTask: async (taskId) => ({ id: taskId, version: 9, assignee: { id: "codex-agent" } }),
    reportDeferred: (report) => deferred.push(report),
  });

  const first = await coordinator.launch({
    task: { id: "task-1", version: 4, assignee: { id: "codex-agent" } },
    expectedVersion: 4,
    trigger: "status-transition",
    presentation: "background",
  });
  assert.equal(first.status, "preparing");
  assert.match(first.message, /正在拉起/);
  assert.deepEqual(native, [], "还没接上就不该派发");

  ready();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(native, [9], "补派发用的是任务当前版本");
  assert.equal(deferred.at(-1)?.result.status, "started");
  // 补派发不再准备第二次：真拉起来又立刻掉了的话，该由 runNative 如实失败，
  // 而不是在「准备 → 补派发 → 又没接上 → 再准备」之间打转。
  assert.equal(prepared.length, 1);
});

test("a client that never comes up leaves the deferred launch reported as failed", async () => {
  const agent = {
    id: "codex",
    label: "Codex",
    actor: { id: "codex-agent" },
    prepareLaunch: async () => ({
      message: "正在拉起 Codex。",
      ready: Promise.reject(new Error("等待 Codex 桥接就绪超时（120 秒）")),
    }),
  };
  const deferred = [];
  const coordinator = createAgentLaunchCoordinator({
    registry: { list: () => [agent] },
    runtimeStatuses: {
      forInteraction: async () => ({ status: "ready", transports: ["native-submit"], stale: false }),
    },
    runNative: async () => assert.fail("客户端没起来就不该派发"),
    reloadTask: async () => assert.fail("失败路径不该再去读任务"),
    reportDeferred: (report) => deferred.push(report),
  });

  const result = await coordinator.launch({
    task: { id: "task-1", version: 1, assignee: { id: "codex-agent" } },
    expectedVersion: 1,
    trigger: "status-transition",
  });
  assert.equal(result.status, "preparing");

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deferred.at(-1)?.result.status, "failed");
  assert.match(deferred.at(-1)?.result.error, /就绪超时/);
});
