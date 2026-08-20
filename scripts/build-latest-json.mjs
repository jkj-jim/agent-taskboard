#!/usr/bin/env node

// 生成 Tauri updater 的 latest.json（document/design/desktop-app-packaging.md §14）。
// 只有非 pre-release 的 stable 版本才允许生成：pre-release 一旦进入 latest.json，
// 所有 production 用户都会被推到 beta 上。

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseAppVersion, profileForVersion } from "../shared/app-version.mjs";

function parseArgs(argv) {
  const options = { tag: null, bundle: null, out: "latest.json" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--tag") options.tag = argv[++index];
    else if (argv[index] === "--bundle") options.bundle = argv[++index];
    else if (argv[index] === "--out") options.out = argv[++index];
    else throw new Error(`Unknown option: ${argv[index]}`);
  }
  for (const key of ["tag", "bundle"]) {
    if (!options[key]) throw new Error(`--${key} is required`);
  }
  return options;
}

export function versionFromTag(tag) {
  if (!tag.startsWith("app-v")) throw new Error(`Release tag must start with app-v, got: ${tag}`);
  return parseAppVersion(tag.slice("app-v".length)).version;
}

export function buildLatestJson({ version, tag, signature, archiveName, pubDate }) {
  if (profileForVersion(version) !== "production") {
    throw new Error(
      `${version} 是 pre-release，不得写入 stable latest.json；beta 只提供手动下载`,
    );
  }
  return {
    version,
    pub_date: pubDate,
    platforms: {
      "darwin-aarch64": {
        signature,
        url: `https://github.com/jkj-jim/agent-taskboard/releases/download/${tag}/${archiveName}`,
      },
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = versionFromTag(options.tag);

  const macosDirectory = path.join(options.bundle, "macos");
  const entries = await readdir(macosDirectory);
  const archiveName = entries.find((entry) => entry.endsWith(".app.tar.gz"));
  if (!archiveName) throw new Error(`No updater artifact under ${macosDirectory}`);

  const signature = (await readFile(
    path.join(macosDirectory, `${archiveName}.sig`),
    "utf8",
  )).trim();
  if (!signature) throw new Error("The updater artifact has no signature");

  const latest = buildLatestJson({
    version,
    tag: options.tag,
    signature,
    archiveName,
    pubDate: new Date().toISOString(),
  });
  await writeFile(options.out, `${JSON.stringify(latest, null, 2)}\n`);
  console.log(JSON.stringify({ ...latest, platforms: Object.keys(latest.platforms) }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
