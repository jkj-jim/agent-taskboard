#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Starts WorkBuddy so the board can drive it.
 *
 * WorkBuddy only opens its debugging port when `WORKBUDDY_REMOTE_DEBUGGING_PORT`
 * is set in the environment of the process itself, and it holds a single
 * instance lock that `--user-data-dir` does not bypass. So an already running
 * client has to quit first — through its own quit flow, because signalling it
 * leaves the app stuck in a half-quit state that cannot be reopened.
 */

const DEFAULT_PORT = 9240;
const APP_DIRECTORIES = ["/Applications", path.join(os.homedir(), "Applications")];
const APP_NAME = "WorkBuddy";

function parsePort(argv) {
  const index = argv.indexOf("--port");
  if (index === -1) return Number(process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT || DEFAULT_PORT);
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`--port must be a valid port number, got ${argv[index + 1]}`);
  }
  return value;
}

function findApp() {
  for (const directory of APP_DIRECTORIES) {
    const bundle = path.join(directory, `${APP_NAME}.app`);
    const binary = path.join(bundle, "Contents", "MacOS", "Electron");
    try {
      accessSync(binary, constants.X_OK);
      return { bundle, binary };
    } catch {}
  }
  return null;
}

function isRunning() {
  const result = spawnSync("/usr/bin/pgrep", ["-f", `${APP_NAME}.app/Contents/MacOS`], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

async function quitApp() {
  spawnSync("/usr/bin/osascript", ["-e", `quit app "${APP_NAME}"`], { encoding: "utf8" });
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (!isRunning()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

async function waitForPort(port) {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return await response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
}

const port = parsePort(process.argv.slice(2));
const app = findApp();
if (!app) {
  console.error(`找不到 ${APP_NAME}.app，请先安装 WorkBuddy。`);
  process.exit(1);
}

if (isRunning()) {
  console.log(`${APP_NAME} 正在运行，先退出它以便带调试端口重新启动…`);
  if (!(await quitApp())) {
    console.error(
      `${APP_NAME} 没有退出。请手动退出（可能有未确认的退出提示）后重试，不要强制结束进程。`,
    );
    process.exit(1);
  }
}

console.log(`启动 ${APP_NAME}，调试端口 ${port}…`);
const child = spawn(app.binary, [], {
  env: { ...process.env, WORKBUDDY_REMOTE_DEBUGGING_PORT: String(port) },
  detached: true,
  stdio: "ignore",
});
child.unref();

const version = await waitForPort(port);
if (!version) {
  console.error(`调试端口 ${port} 没有就绪。请确认 WorkBuddy 已完成启动后重试。`);
  process.exit(1);
}
console.log(`就绪：${version.Browser}`);
console.log("现在可以在任务面板里把任务指派给 WorkBuddy 并派发。");
