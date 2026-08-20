#!/usr/bin/env node
// 抽取 CHANGELOG.md 里某个版本的小节，作为 GitHub Release 的说明正文。
//
//   node scripts/extract-changelog.mjs --version 0.1.0
//   node scripts/extract-changelog.mjs --version 2.1.0-beta.1 --allow-missing
//
// 正式版发布不给 --allow-missing：宁可让发布失败，也不要发出一个说明为空的
// Release。Release 一旦建好，assets 就已经上传出去了，回头补说明很容易漏。

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const HEADING = /^##\s+(\S+)\s*$/;

export function extractChangelogSection(markdown, version) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => HEADING.exec(line)?.[1] === version);
  if (start === -1) return null;
  // 到下一个同级标题为止；文件末尾也算边界
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (HEADING.test(lines[index])) {
      end = index;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body.length > 0 ? body : null;
}

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

function main() {
  const version = argValue("--version");
  if (!version) throw new Error("需要 --version <x.y.z>");
  const changelogPath = argValue("--changelog", "CHANGELOG.md");
  const allowMissing = process.argv.includes("--allow-missing");

  const section = extractChangelogSection(readFileSync(changelogPath, "utf8"), version);
  if (section) {
    process.stdout.write(`${section}\n\n`);
    return;
  }
  if (allowMissing) return;
  throw new Error(
    `${changelogPath} 里没有 ${version} 的小节，或者那一节是空的。`
    + `发布正式版前先在 CHANGELOG.md 里加一节 "## ${version}"。`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
