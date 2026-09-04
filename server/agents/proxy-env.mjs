// Agent 子进程的代理环境（document/design/desktop-app-packaging.md §6）。
//
// 和 agent-path.mjs 是同一个根因的两半：Finder 启动的 App 只拿到 launchd 的默认
// 环境，用户 shell 里配的代理一个都不在。终端跑 `npm run dev` 不会暴露这个问题，
// 因为那条路径继承的是用户 shell 的环境。
//
// 后果不是「慢」或「连不上」，而是 `claude` 直连 api.anthropic.com 被边缘节点拒
// 掉，返回 403 Request not allowed。CLI 把它归类成 authentication_failed，界面上
// 看起来就是「授权失败」——但登录状态完全正常，`claude auth status` 也是已登录。
// 引导用户重新登录解决不了，所以这里必须在 spawn 前把代理补回去。
//
// 不去读用户的 shell 配置：要在 GUI 进程里跑别人的 rc 文件，慢且不可控，而且
// rc 里的代理往往只在交互式 shell 生效。macOS 的系统代理设置由 SystemConfiguration
// 提供，GUI 进程读得到，且正是代理客户端（v2rayN / Clash 等）「设为系统代理」时
// 写入的那份，比复刻用户 rc 的探测逻辑更接近事实。
//
// 每次 spawn 前重新探测而不是启动时快照一次：看板是长驻进程，用户中途开关代理
// 客户端或换一个端口，快照就失效了。探测只读本机配置加一次 localhost 连接，成本
// 低到可以每轮都做。

import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SCUTIL_TIMEOUT_MS = 2_000;
const REACHABILITY_TIMEOUT_MS = 300;

/** 大小写两种写法都设：不同的运行时只认其中一种，设一半等于没设。 */
const PROXY_ENV_NAMES = {
  http: ["HTTP_PROXY", "http_proxy"],
  https: ["HTTPS_PROXY", "https_proxy"],
  no: ["NO_PROXY", "no_proxy"],
};

/**
 * 本机地址必须绕过代理：Agent 通过 `taskctl` 回访看板自己的
 * http://127.0.0.1:<port>，走代理会直接失败。用户已经设了就尊重用户的。
 */
const LOCAL_BYPASS = "localhost,127.0.0.1,::1,.local";

function hasProxy(env) {
  return [...PROXY_ENV_NAMES.http, ...PROXY_ENV_NAMES.https]
    .some((name) => typeof env[name] === "string" && env[name].length > 0);
}

/**
 * `scutil --proxy` 输出的是 SystemConfiguration 的字典字面量，不是 JSON：
 *
 *   <dictionary> {
 *     HTTPSEnable : 1
 *     HTTPSProxy : 127.0.0.1
 *     HTTPSPort : 10808
 *   }
 *
 * 只取需要的几个键，值按 `key : value` 逐行读。
 */
export function parseScutilProxy(stdout) {
  const fields = {};
  for (const line of String(stdout).split("\n")) {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/);
    if (match) fields[match[1]] = match[2];
  }
  const read = (prefix) => {
    if (fields[`${prefix}Enable`] !== "1") return null;
    const host = fields[`${prefix}Proxy`];
    const port = Number(fields[`${prefix}Port`]);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  };
  return { http: read("HTTP"), https: read("HTTPS") };
}

/** 端口没人听就别注入：指向一个死代理比直连更糟，直连至少还有可能通。 */
export function reachable(host, port, timeoutMs = REACHABILITY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function readSystemProxy(runCommand) {
  try {
    const { stdout } = await execScutil(runCommand);
    return parseScutilProxy(stdout);
  } catch {
    // 非 macOS、scutil 不在、或者读不出来：当作没有系统代理，直连。
    return { http: null, https: null };
  }
}

function execScutil(runCommand) {
  return runCommand("scutil", ["--proxy"], {
    encoding: "utf8",
    timeout: SCUTIL_TIMEOUT_MS,
  });
}

/**
 * 在 spawn 前补上代理环境变量。环境里已经有代理时原样返回——开发版继承的是用户
 * shell 的设置，那是用户的显式选择，不该被系统代理覆盖。
 */
export async function withProxyEnv(env, {
  runCommand = execFileAsync,
  checkReachable = reachable,
} = {}) {
  if (hasProxy(env)) return env;

  const system = await readSystemProxy(runCommand);
  const https = system.https ?? system.http;
  const http = system.http ?? system.https;
  if (!https && !http) return env;

  const usable = await Promise.all(
    [...new Set([https, http].filter(Boolean))]
      .map(async (entry) => (await checkReachable(entry.host, entry.port) ? entry : null)),
  );
  const live = new Set(usable.filter(Boolean));
  if (live.size === 0) return env;

  const next = { ...env };
  const assign = (names, entry) => {
    if (!entry || !live.has(entry)) return;
    for (const name of names) next[name] = `http://${entry.host}:${entry.port}`;
  };
  assign(PROXY_ENV_NAMES.https, https);
  assign(PROXY_ENV_NAMES.http, http);
  for (const name of PROXY_ENV_NAMES.no) {
    if (!next[name]) next[name] = LOCAL_BYPASS;
  }
  return next;
}
