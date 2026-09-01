import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { DEFAULT_WORKBUDDY_DEBUGGING_PORT } from "./workbuddy-desktop-controller.mjs";

const execFileAsync = promisify(execFile);
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function runCommand(file, args) {
  return execFileAsync(file, args, { encoding: "utf8" });
}

async function appIsRunning() {
  try {
    const result = await runCommand("/usr/bin/pgrep", [
      "-f",
      "WorkBuddy.app/Contents/MacOS",
    ]);
    return result.stdout.trim().length > 0;
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
}

async function debuggingEndpoint(port, fetchImplementation = globalThis.fetch) {
  try {
    const response = await fetchImplementation(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/**
 * Restarts WorkBuddy with its supported debugging environment variable. This is
 * deliberately exposed only behind a user-confirmed UI action: WorkBuddy has a
 * single-instance lock, so a normally running client must fully quit first.
 */
export function createWorkbuddyAppLauncher({
  port = DEFAULT_WORKBUDDY_DEBUGGING_PORT,
  execute = runCommand,
  isRunning = appIsRunning,
  probe = () => debuggingEndpoint(port),
  wait = pause,
  quitAttempts = 25,
  launchAttempts = 45,
} = {}) {
  async function waitUntil(predicate, attempts) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await predicate();
      if (result) return result;
      await wait(1_000);
    }
    return null;
  }

  return {
    async connect() {
      const connected = await probe();
      if (connected) return { state: "connected", restarted: false, port };

      if (await isRunning()) {
        await execute("/usr/bin/osascript", ["-e", 'quit app "WorkBuddy"']);
        const stopped = await waitUntil(async () => !(await isRunning()), quitAttempts);
        if (!stopped) {
          throw new Error("WorkBuddy 没有退出；请处理未保存内容或退出确认后重试。");
        }
      }

      await execute("/usr/bin/open", [
        "-a",
        "WorkBuddy",
        "--env",
        `WORKBUDDY_REMOTE_DEBUGGING_PORT=${port}`,
      ]);
      const version = await waitUntil(probe, launchAttempts);
      if (!version) {
        throw new Error(`WorkBuddy 已重新打开，但调试端口 ${port} 没有就绪。`);
      }
      return {
        state: "connected",
        restarted: true,
        port,
        version: typeof version.Browser === "string" ? version.Browser : undefined,
      };
    },
  };
}
