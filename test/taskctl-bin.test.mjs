import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  createTaskctlRuntime,
  ensureTaskctlBin,
} from "../server/agents/taskctl-bin.mjs";

const execFile = promisify(execFileCallback);

test("taskctl runtime requires the listening origin before use", () => {
  const runtime = createTaskctlRuntime({
    binDirectory: "/tmp/taskctl-runtime/bin",
    cliPath: "/tmp/taskctl-runtime/taskctl.mjs",
  });

  assert.throws(() => runtime.currentOrigin(), /not initialized/);
  assert.throws(() => runtime.ensureReady(), /not initialized/);
  runtime.initialize("http://127.0.0.1:49123");
  assert.equal(runtime.currentOrigin(), "http://127.0.0.1:49123");
  assert.throws(() => runtime.initialize("http://127.0.0.1:49124"), /already initialized/);
});

test("taskctl runtime memoizes one shim write across concurrent consumers", async () => {
  let callCount = 0;
  let releaseWrite;
  const writeGate = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const runtime = createTaskctlRuntime({
    binDirectory: "/tmp/taskctl-runtime/bin",
    cliPath: "/tmp/taskctl-runtime/taskctl.mjs",
    ensureBin: async ({ binDirectory }) => {
      callCount += 1;
      await writeGate;
      return binDirectory;
    },
  });
  runtime.initialize("http://127.0.0.1:49123");

  const ready = runtime.ensureReady();
  const shimPath = runtime.shimPath();
  const environment = runtime.environment({
    PATH: "/usr/bin",
    // 上一个实例留下的旧名地址
    CODEX_TASKBOARD_URL: "http://127.0.0.1:1",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callCount, 1);

  releaseWrite();
  assert.equal(await ready, "/tmp/taskctl-runtime/bin");
  assert.equal(await shimPath, "/tmp/taskctl-runtime/bin/taskctl");
  // 旧名被删掉而不是留着：两个互相矛盾的地址会让照旧名调试的人连到上一个实例
  assert.deepEqual(await environment, {
    PATH: `/tmp/taskctl-runtime/bin${path.delimiter}/usr/bin`,
    AGENT_TASKBOARD_URL: "http://127.0.0.1:49123",
  });
});

test("the generated shim quotes paths, overrides stale origins, and remains callable from PATH", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskctl-bin's-"));
  try {
    const cliPath = path.join(directory, "fake taskctl's.mjs");
    await writeFile(cliPath, `process.stdout.write(JSON.stringify({
  taskboardUrl: process.env.AGENT_TASKBOARD_URL,
  legacy: process.env.CODEX_TASKBOARD_URL ?? null,
  args: process.argv.slice(2),
}));\n`);
    const runtime = createTaskctlRuntime({
      binDirectory: path.join(directory, "bin with space"),
      cliPath,
    });
    runtime.initialize("http://127.0.0.1:49123");

    // 环境里留一个旧名的过期地址，shim 必须盖过它
    const staleEnvironment = {
      ...process.env,
      CODEX_TASKBOARD_URL: "http://127.0.0.1:1",
    };
    const direct = await execFile(
      await runtime.shimPath(),
      ["issue", "brief", "TASK-1"],
      { env: staleEnvironment },
    );
    // shim 只设规范名，旧名原样透传——规范名优先，所以读到的是当前实例
    assert.deepEqual(JSON.parse(direct.stdout), {
      taskboardUrl: "http://127.0.0.1:49123",
      legacy: "http://127.0.0.1:1",
      args: ["issue", "brief", "TASK-1"],
    });

    const fromPath = await execFile(
      "taskctl",
      ["comment", "list", "TASK-1"],
      { env: await runtime.environment(staleEnvironment) },
    );
    // 走 runtime.environment 时旧名已被删掉，子进程里只剩规范名
    assert.deepEqual(JSON.parse(fromPath.stdout), {
      taskboardUrl: "http://127.0.0.1:49123",
      legacy: null,
      args: ["comment", "list", "TASK-1"],
    });

    assert.equal(await ensureTaskctlBin({
      binDirectory: path.join(directory, "second-bin"),
      cliPath,
      taskboardUrl: "http://127.0.0.1:49124",
    }), path.join(directory, "second-bin"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
