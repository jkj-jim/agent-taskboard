import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTaskboardServer } from "./app.mjs";
import { ensureSkillInstalled, stageSkillTemplate } from "./agents/skill-install.mjs";
import { parseSidecarArgv } from "./sidecar-options.mjs";

export { createTaskboardServer, resolveHost, resolvePort, resolveServerOptions } from "./app.mjs";
export { parseSidecarArgv } from "./sidecar-options.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  // 解析在建库之前：安装版的版本/profile 握手必须在打开 SQLite 前完成。
  const { mode, listen, options } = parseSidecarArgv(process.argv.slice(2), {
    projectRoot: PROJECT_ROOT,
  });

  const app = createTaskboardServer(options);
  const address = await app.listen(listen);
  console.log(
    `Agent Taskboard listening on http://127.0.0.1:${address.port}`
    + ` (${mode}${options.profile ? ` ${options.profile}` : ""} ${options.appVersion})`,
  );
  if (listen.host === "0.0.0.0") {
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((entry) => entry?.family === "IPv4" && !entry.internal)
      .map((entry) => entry.address);
    for (const lanAddress of [...new Set(addresses)]) {
      console.log(`Agent Taskboard available on LAN at http://${lanAddress}:${address.port}`);
    }
  }

  // production 负责安装共享 skill 并为 Claude 建软链；beta 只读、开发版不参与（§7）。
  // 安装失败不该挡住看板启动，所以只记录。
  if (options.profile) {
    try {
      const report = await ensureSkillInstalled({
        profile: options.profile,
        skillDirectory: path.dirname(options.skillPath),
        templateDirectory: path.join(PROJECT_ROOT, "skills", "manage-taskboard"),
        claudeHome: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
        appVersion: options.appVersion,
        installedAt: new Date().toISOString(),
      });
      // 本版本携带的模板存进 profile 的版本化目录，供后续差异查看；不碰共享 skill。
      await stageSkillTemplate({
        profileDirectory: options.dataDirectory,
        templateDirectory: path.join(PROJECT_ROOT, "skills", "manage-taskboard"),
        appVersion: options.appVersion,
      });
      if (report.changes.length > 0) console.log(`manage-taskboard skill: ${report.changes.join(", ")}`);
      if (report.claudeLink.state === "conflict") {
        console.warn(
          `manage-taskboard skill: ${report.claudeLink.path} 指向 ${report.claudeLink.target}，`
          + "与看板安装的 skill 不是同一份；已保留现状未做改动。",
        );
      }
    } catch (error) {
      console.error(`manage-taskboard skill setup failed: ${error.message}`);
    }
  }

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once("SIGINT", () => close().then(() => process.exit(0)));
  process.once("SIGTERM", () => close().then(() => process.exit(0)));

  // Tauri 的退出事件只在 macOS 正常退出路径触发；壳被强杀或崩溃时不会有人来发 SIGTERM，
  // sidecar 会变成孤儿并继续占着端口和 SQLite。所以安装版自己盯着父进程。
  if (mode === "installed") {
    const parentPid = process.ppid;
    const watchdog = setInterval(() => {
      if (process.ppid === parentPid) return;
      clearInterval(watchdog);
      console.error(`Agent Taskboard shell (pid ${parentPid}) is gone; closing the sidecar.`);
      close().then(() => process.exit(0));
    }, 2_000);
    watchdog.unref();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
