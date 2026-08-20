#!/usr/bin/env node

// P0 sidecar 直接路径验收（document/design/desktop-app-packaging.md §15 P0、§17）：
// 用随包 Node 二进制起 server/index.mjs，逐项确认 node:sqlite、/health、taskctl shim
// 和 SIGTERM 优雅退出。不依赖 GUI，所以 GitHub Actions 上也能跑。

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultSidecar = path.join(projectRoot, "src-tauri", "binaries", "node-aarch64-apple-darwin");

function parseArgs(argv) {
  const options = { node: defaultSidecar, port: null, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--node") options.node = path.resolve(argv[++index]);
    else if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg === "--keep") options.keep = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "never reachable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`/health never became ready: ${lastError}`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ exited: false }), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ exited: true, code, signal });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.node)) {
    throw new Error(`Bundled Node is missing at ${options.node}; run npm run sidecar:node first`);
  }

  const nodeVersion = spawnSync(options.node, ["--version"], { encoding: "utf8" })
    .stdout.trim();

  // node:sqlite 与 sqlite.backup() 都必须在随包运行时上可用；后者是 >=22.16 的原因。
  const sqliteProbe = spawnSync(options.node, [
    "-e",
    `const sqlite = require("node:sqlite");
     const db = new sqlite.DatabaseSync(":memory:");
     db.exec("CREATE TABLE probe(value TEXT)");
     db.prepare("INSERT INTO probe VALUES (?)").run("ok");
     process.stdout.write(JSON.stringify({
       value: db.prepare("SELECT value FROM probe").get().value,
       backup: typeof sqlite.backup,
     }));
     db.close();`,
  ], { encoding: "utf8" });
  if (sqliteProbe.status !== 0) {
    throw new Error(`node:sqlite probe failed: ${sqliteProbe.stderr.trim()}`);
  }
  const sqlite = JSON.parse(sqliteProbe.stdout);
  if (sqlite.value !== "ok" || sqlite.backup !== "function") {
    throw new Error(`node:sqlite probe returned ${sqliteProbe.stdout}`);
  }

  const port = options.port ?? (await freePort());
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "taskboard-sidecar-"));
  const databasePath = path.join(dataDirectory, "taskboard.sqlite");
  const shimPath = path.join(dataDirectory, "bin", "taskctl");

  const child = spawn(options.node, [path.join(projectRoot, "server", "index.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_TASKBOARD_HOST: "127.0.0.1",
      CODEX_TASKBOARD_PORT: String(port),
      CODEX_TASKBOARD_DATA_DIR: dataDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

  const report = { node: options.node, nodeVersion, port, dataDirectory, sqlite };
  try {
    report.health = await waitForHealth(port, 30_000);

    // shim 是首次 Agent 使用时才落盘的，/api/meta 是它对外暴露的入口。
    const meta = await fetch(`http://127.0.0.1:${port}/api/meta`, {
      signal: AbortSignal.timeout(20_000),
    }).then((response) => response.json());
    if (meta.taskctlShimPath !== shimPath) {
      throw new Error(`/api/meta reported shim ${meta.taskctlShimPath}, expected ${shimPath}`);
    }
    if (!existsSync(shimPath)) throw new Error(`taskctl shim was not created at ${shimPath}`);
    const shim = spawnSync(shimPath, ["project", "list", "--json"], { encoding: "utf8" });
    if (shim.status !== 0) throw new Error(`taskctl shim failed: ${shim.stderr.trim()}`);
    report.shim = { path: shimPath, response: JSON.parse(shim.stdout) };

    child.kill("SIGTERM");
    const exit = await waitForExit(child, 10_000);
    if (!exit.exited) throw new Error("sidecar ignored SIGTERM");
    report.shutdown = exit;

    // 干净关闭会把 WAL 归并回主库并删掉 -wal / -shm；残留即说明没有正常收尾。
    const leftovers = [];
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${databasePath}${suffix}`)) leftovers.push(suffix);
    }
    if (leftovers.length > 0) {
      throw new Error(`SQLite was not closed cleanly, leftovers: ${leftovers.join(", ")}`);
    }
    report.database = {
      path: databasePath,
      bytes: (await stat(databasePath)).size,
      walCheckpointed: true,
    };

    const integrity = spawnSync(options.node, [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(process.argv[1]);
       process.stdout.write(JSON.stringify({
         integrity: db.prepare("PRAGMA integrity_check").get().integrity_check,
         foreignKeys: db.prepare("PRAGMA foreign_key_check").all().length,
       }));
       db.close();`,
      databasePath,
    ], { encoding: "utf8" });
    if (integrity.status !== 0) throw new Error(`integrity check failed: ${integrity.stderr.trim()}`);
    const integrityResult = JSON.parse(integrity.stdout);
    if (integrityResult.integrity !== "ok" || integrityResult.foreignKeys !== 0) {
      throw new Error(`database is not healthy: ${integrity.stdout}`);
    }
    report.database.integrity = integrityResult;
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL");
    error.message = `${error.message}\nsidecar stderr:\n${stderr.join("")}`;
    throw error;
  } finally {
    if (!options.keep) await rm(dataDirectory, { recursive: true, force: true });
  }

  console.log(JSON.stringify({ ...report, verdict: "ok" }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
