#!/usr/bin/env node

// 下载随包 Node 二进制并放到 Tauri externalBin 期望的位置。
// 版本单一来源是 .nvmrc（document/design/desktop-app-packaging.md §4），
// 校验对象是 Node 官方 SHASUMS256.txt，校验不通过绝不落盘到 src-tauri/binaries。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distBaseUrl = process.env.NODE_DIST_BASE_URL || "https://nodejs.org/dist";

// 一期只交付 macOS arm64；其他平台明确报错，不静默产出不可用的 sidecar。
const supportedTargets = new Map([
  ["darwin-arm64", { nodePlatform: "darwin-arm64", targetTriple: "aarch64-apple-darwin" }],
]);

export function readPinnedNodeVersion(nvmrcContents) {
  const version = nvmrcContents.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`.nvmrc must pin an exact Node version, got: ${nvmrcContents.trim()}`);
  }
  return version;
}

export function findChecksum(shasums, fileName) {
  for (const line of shasums.split("\n")) {
    const [checksum, name] = line.trim().split(/\s+/);
    if (name === fileName) return checksum;
  }
  throw new Error(`${fileName} is missing from SHASUMS256.txt`);
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

function installedVersion(binaryPath) {
  if (!existsSync(binaryPath)) return null;
  const result = spawnSync(binaryPath, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim().replace(/^v/, "");
}

async function main() {
  const force = process.argv.includes("--force");
  const target = supportedTargets.get(`${process.platform}-${process.arch}`);
  if (!target) {
    throw new Error(`Unsupported platform ${process.platform}-${process.arch}; 一期只支持 darwin-arm64`);
  }

  const version = readPinnedNodeVersion(await readFile(path.join(projectRoot, ".nvmrc"), "utf8"));
  const binaryPath = path.join(projectRoot, "src-tauri", "binaries", `node-${target.targetTriple}`);

  if (!force && installedVersion(binaryPath) === version) {
    console.log(JSON.stringify({ version, binaryPath, status: "up-to-date" }, null, 2));
    return;
  }

  const archiveName = `node-v${version}-${target.nodePlatform}.tar.gz`;
  const [archive, shasums] = await Promise.all([
    download(`${distBaseUrl}/v${version}/${archiveName}`),
    download(`${distBaseUrl}/v${version}/SHASUMS256.txt`).then((buffer) => buffer.toString("utf8")),
  ]);

  const expected = findChecksum(shasums, archiveName);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) {
    throw new Error(`${archiveName} checksum mismatch: expected ${expected}, got ${actual}`);
  }

  const workDirectory = await mkdtemp(path.join(os.tmpdir(), "node-sidecar-"));
  try {
    const archivePath = path.join(workDirectory, archiveName);
    await writeFile(archivePath, archive);
    const extracted = spawnSync("/usr/bin/tar", [
      "-xzf",
      archivePath,
      "-C",
      workDirectory,
      `node-v${version}-${target.nodePlatform}/bin/node`,
    ], { encoding: "utf8" });
    if (extracted.status !== 0) {
      throw new Error(`Failed to extract ${archiveName}: ${extracted.stderr.trim()}`);
    }

    await mkdir(path.dirname(binaryPath), { recursive: true });
    await rename(
      path.join(workDirectory, `node-v${version}-${target.nodePlatform}`, "bin", "node"),
      binaryPath,
    );
    await chmod(binaryPath, 0o755);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }

  const resolved = installedVersion(binaryPath);
  if (resolved !== version) {
    throw new Error(`Downloaded sidecar reports v${resolved}, expected v${version}`);
  }

  console.log(JSON.stringify({
    version,
    archive: archiveName,
    sha256: expected,
    binaryPath,
    status: "downloaded",
  }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
