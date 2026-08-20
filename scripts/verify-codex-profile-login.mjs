#!/usr/bin/env node

// P0 第一验收门（document/design/desktop-app-packaging.md §9）：
// 验证 App Data 下独立的 Codex automation profile 能否复用用户现有登录态。
// 登录凭据保存在 CODEX_HOME（默认 ~/.codex），与 Electron 的 --user-data-dir 无关；
// 只要不覆盖 CODEX_HOME，隔离 profile 启动后就是已登录状态。
// Codex 版本升级后可以重跑本脚本确认该结论仍然成立。

import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CdpConnection } from "../shared/codex-cdp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cdpHosts = ["127.0.0.1", "[::1]"];

function parseArgs(argv) {
  const options = {
    profileDir: path.join(projectRoot, ".data", "codex-profile-verify"),
    codexHome: null,
    port: 9351,
    appPath: "/Applications/ChatGPT.app",
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile-dir") options.profileDir = path.resolve(argv[++index]);
    else if (arg === "--codex-home") options.codexHome = path.resolve(argv[++index]);
    else if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg === "--app-path") options.appPath = path.resolve(argv[++index]);
    else if (arg === "--keep") options.keep = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return options;
}

async function readAuthState(codexHome) {
  const authPath = path.join(codexHome, "auth.json");
  try {
    const auth = JSON.parse(await readFile(authPath, "utf8"));
    return {
      path: authPath,
      exists: true,
      authMode: auth.auth_mode ?? null,
      hasTokens: Boolean(auth.tokens?.access_token),
    };
  } catch (error) {
    if (error.code === "ENOENT") return { path: authPath, exists: false };
    throw error;
  }
}

// Chromium 在 IPv4 端口被占用时会退回 [::1]，所以两个协议栈都要空出来；
// 否则 127.0.0.1:<port> 上可能坐着完全无关的另一个应用。
function portInUse(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: host.replace(/^\[|\]$/g, ""), port });
    const settle = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(800);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

function launchCodex({ appPath, profileDir, port, codexHome }) {
  const executableName = path.basename(appPath, path.extname(appPath));
  const env = { ...process.env, CODEX_ELECTRON_USER_DATA_PATH: profileDir };
  if (codexHome) env.CODEX_HOME = codexHome;
  return spawn(path.join(appPath, "Contents", "MacOS", executableName), [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
  ], { detached: true, env, stdio: "ignore" });
}

// 只认 Codex 自己的主渲染进程，避免连上碰巧监听同一端口的其他应用。
async function resolveCodexTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const host of cdpHosts) {
      try {
        const targets = await fetch(`http://${host}:${port}/json/list`, {
          signal: AbortSignal.timeout(1_000),
        }).then((response) => response.json());
        const target = targets.find(
          (candidate) => candidate.type === "page" && candidate.url === "app://-/index.html",
        );
        if (target) return { host, target };
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

// 已登录的唯一稳定信号是原生 composer；登录页只有几个本地化文案按钮，
// 没有可依赖的结构化属性，所以不做文案匹配。
async function waitForSignedInSurface(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let surface = null;
  while (Date.now() < deadline) {
    const evaluation = await cdp.send("Runtime.evaluate", {
      expression: `(() => ({
        composer: Boolean(document.querySelector('[data-codex-composer="true"]')),
        sidebar: Boolean(document.querySelector('[data-app-action-sidebar-section]')),
        headline: (document.body?.innerText || "").replace(/\\s+/g, " ").slice(0, 80),
      }))()`,
      returnByValue: true,
    });
    surface = evaluation.result.value;
    if (surface.composer) return { signedIn: true, ...surface };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { signedIn: false, ...surface };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const codexHome = options.codexHome
    || process.env.CODEX_HOME
    || path.join(os.homedir(), ".codex");
  const auth = await readAuthState(codexHome);

  for (const host of cdpHosts) {
    if (await portInUse(host, options.port)) {
      throw new Error(`Port ${options.port} is already in use on ${host}; pass a free --port`);
    }
  }

  await mkdir(options.profileDir, { recursive: true });
  const child = launchCodex({ ...options, codexHome: options.codexHome });
  let endpoint = null;
  let surface = null;
  try {
    endpoint = await resolveCodexTarget(options.port, 45_000);
    if (!endpoint) throw new Error("Codex CDP target did not appear; is ChatGPT.app installed?");
    const cdp = new CdpConnection(endpoint.target.webSocketDebuggerUrl);
    await cdp.open();
    try {
      await cdp.send("Runtime.enable");
      surface = await waitForSignedInSurface(cdp, 30_000);
    } finally {
      cdp.close();
    }
  } finally {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    if (!options.keep) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await rm(options.profileDir, { recursive: true, force: true });
    }
  }

  const verdict = surface.signedIn
    ? "reuses-existing-login"
    : (auth.hasTokens ? "isolated-profile-lost-login" : "codex-home-not-signed-in");
  console.log(JSON.stringify({
    codexHome,
    auth,
    profileDir: options.profileDir,
    profileKept: options.keep,
    port: options.port,
    cdpHost: endpoint?.host ?? null,
    surface,
    verdict,
  }, null, 2));
  if (verdict === "isolated-profile-lost-login") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
