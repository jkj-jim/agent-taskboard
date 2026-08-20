#!/usr/bin/env node

// 把 package.json#version 这一个完整 SemVer 同步到所有构建期目标
// （document/design/desktop-app-packaging.md §4「App 版本来源」）。
// --check 只比对不写入，CI 用它在任一目标漂移时失败。

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseAppVersion, profileForVersion } from "../shared/app-version.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedBanner = "// 由 scripts/sync-app-version.mjs 生成，不要手改；改 package.json#version。";

export function renderEsmConstant(version) {
  return `${generatedBanner}\n\nexport const APP_VERSION_FULL = ${JSON.stringify(version)};\n`;
}

export function renderRustConstant(version) {
  return `${generatedBanner}\n\npub const APP_VERSION_FULL: &str = ${JSON.stringify(version)};\n`;
}

// 只替换顶层 version 行，避免重排 JSON 或 TOML 里其他字段的格式。
export function replaceJsonVersion(source, version) {
  const pattern = /^(\s*"version"\s*:\s*)"[^"]*"/m;
  if (!pattern.test(source)) throw new Error("tauri.conf.json has no top-level version field");
  return source.replace(pattern, `$1${JSON.stringify(version)}`);
}

export function replaceCargoVersion(source, version) {
  const pattern = /^(version\s*=\s*)"[^"]*"/m;
  if (!pattern.test(source)) throw new Error("Cargo.toml has no package version field");
  return source.replace(pattern, `$1${JSON.stringify(version)}`);
}

async function targetsFor(version) {
  const tauriConfigPath = path.join(projectRoot, "src-tauri", "tauri.conf.json");
  const cargoPath = path.join(projectRoot, "src-tauri", "Cargo.toml");
  return [
    {
      path: path.join(projectRoot, "shared", "app-version.generated.mjs"),
      contents: renderEsmConstant(version),
    },
    {
      path: path.join(projectRoot, "src-tauri", "src", "app_version_generated.rs"),
      contents: renderRustConstant(version),
    },
    {
      path: tauriConfigPath,
      contents: replaceJsonVersion(await readFile(tauriConfigPath, "utf8"), version),
    },
    {
      path: cargoPath,
      contents: replaceCargoVersion(await readFile(cargoPath, "utf8"), version),
    },
  ];
}

async function main() {
  const check = process.argv.includes("--check");
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const { version, prerelease } = parseAppVersion(manifest.version);
  const profile = profileForVersion(version);

  const targets = await targetsFor(version);
  const drifted = [];
  for (const target of targets) {
    const current = await readFile(target.path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current === target.contents) continue;
    drifted.push(path.relative(projectRoot, target.path));
    if (!check) await writeFile(target.path, target.contents);
  }

  if (check && drifted.length > 0) {
    throw new Error(
      `以下目标与 package.json#version (${version}) 不一致：${drifted.join(", ")}\n`
      + "运行 npm run sync:version 重新生成。",
    );
  }

  console.log(JSON.stringify({
    version,
    prerelease,
    profile,
    mode: check ? "check" : "write",
    [check ? "consistent" : "updated"]: check ? drifted.length === 0 : drifted,
  }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
