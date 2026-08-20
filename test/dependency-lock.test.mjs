import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the lockfile resolves everything through the canonical registry", async () => {
  const lockfile = await readFile(path.join(projectRoot, "package-lock.json"), "utf8");
  const hosts = new Set(
    [...lockfile.matchAll(/"resolved":\s*"https?:\/\/([^/"]+)/g)].map((match) => match[1]),
  );

  // 私有镜像地址一旦被写进 resolved，CI 也会去那个镜像拉包——等于让发布流程依赖
  // 一个项目没有选择过的第三方主机。npm 的 replace-registry-host 默认会把
  // registry.npmjs.org 换成本机配置的 registry，所以锁文件写规范地址时，用镜像的
  // 机器照样走镜像，两边都对。
  assert.deepEqual([...hosts], ["registry.npmjs.org"]);
});

test("every dependency package.json declares is present in the lockfile", async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));

  // `npm ci` 只在锁文件与 package.json 同步时才装，不同步会以 EUSAGE 直接失败。
  // 这里挡的是最容易手工改坏的一层：顶层依赖漏在锁文件外面。
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  const root = lockfile.packages[""];
  assert.deepEqual(root.dependencies ?? {}, manifest.dependencies);
  assert.deepEqual(root.devDependencies ?? {}, manifest.devDependencies);
  for (const name of Object.keys(declared)) {
    assert.ok(
      lockfile.packages[`node_modules/${name}`],
      `锁文件里没有 ${name}，npm ci 会报 Missing from lock file`,
    );
  }
});

test("no dependency requirement points at a package the lockfile never resolved", async () => {
  const lockfile = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  const entries = Object.entries(lockfile.packages);

  // 这条正是这次 CI 挂掉的形态：@tiptap/extension-bubble-menu 要 @floating-ui/dom，
  // 而锁文件里根本没有任何 @floating-ui/dom 条目。本机 npm 11 容忍，CI 的 npm 10
  // 直接 EUSAGE。
  //
  // 不能因为条目带 optional 就跳过——挂掉的 bubble-menu 恰好就是 optional 的，
  // npm 照样要求它的依赖被解析出来。
  const missing = [];
  for (const [location, meta] of entries) {
    for (const name of Object.keys(meta.dependencies ?? {})) {
      // 依赖可以落在本级 node_modules 或任一层祖先的 node_modules 上，
      // 一路回退到顶层
      const candidates = [];
      let scope = location;
      while (true) {
        candidates.push(scope ? `${scope}/node_modules/${name}` : `node_modules/${name}`);
        if (!scope) break;
        const cut = scope.lastIndexOf("/node_modules/");
        scope = cut === -1 ? "" : scope.slice(0, cut);
      }
      if (!candidates.some((candidate) => lockfile.packages[candidate])) {
        missing.push(`${location || "(root)"} -> ${name}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
