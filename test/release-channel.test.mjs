import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildLatestJson, versionFromTag } from "../scripts/build-latest-json.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const artifact = {
  tag: "app-v2.1.0",
  signature: "SIG",
  archiveName: "Agent Taskboard.app.tar.gz",
  pubDate: "2026-08-19T00:00:00.000Z",
};

test("a release tag must carry the complete SemVer", () => {
  assert.equal(versionFromTag("app-v2.1.0"), "2.1.0");
  assert.equal(versionFromTag("app-v2.1.0-beta.1"), "2.1.0-beta.1");
  assert.throws(() => versionFromTag("v2.1.0"), /must start with app-v/);
  assert.throws(() => versionFromTag("app-v2.1"), /complete SemVer/);
});

test("a pre-release can never be written into the stable latest.json", () => {
  // 一旦 beta 进了 latest.json，所有 production 用户都会被推到 beta 上。
  assert.throws(
    () => buildLatestJson({ ...artifact, version: "2.1.0-beta.1" }),
    /不得写入 stable latest\.json/,
  );
  assert.throws(
    () => buildLatestJson({ ...artifact, version: "2.1.0-rc.1" }),
    /不得写入 stable latest\.json/,
  );
});

test("a stable latest.json points at the tagged arm64 artifact", () => {
  const latest = buildLatestJson({ ...artifact, version: "2.1.0" });
  assert.equal(latest.version, "2.1.0");
  assert.deepEqual(Object.keys(latest.platforms), ["darwin-aarch64"]);
  assert.equal(latest.platforms["darwin-aarch64"].signature, "SIG");
  assert.match(latest.platforms["darwin-aarch64"].url, /\/releases\/download\/app-v2\.1\.0\//);
});

test("both workflows stay parseable YAML", async () => {
  // `run: |` 是 YAML 块标量，里面任何顶格的行都会把块提前结束，整个文件随之不合法。
  // Actions 对不合法的 workflow 不报语法错，只是把它显示成一个立刻失败的文件路径，
  // 很容易被当成「某一步跑挂了」。heredoc 正文必须顶格，正是最容易踩进来的写法。
  const TOP_LEVEL_KEYS = ["name:", "on:", "permissions:", "jobs:", "env:", "defaults:", "concurrency:", "run-name:"];
  for (const name of ["macos-verify.yml", "macos-release.yml"]) {
    const workflow = await readFile(
      path.join(projectRoot, ".github", "workflows", name),
      "utf8",
    );
    const stray = workflow.split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => line.length > 0 && !line.startsWith(" ") && !line.startsWith("#"))
      .filter(({ line }) => !TOP_LEVEL_KEYS.some((key) => line.startsWith(key)))
      .map(({ line, number }) => `${name}:${number} ${line.slice(0, 40)}`);
    assert.deepEqual(stray, []);
  }
});

test("the release workflow keeps the channel discipline the design fixes", async () => {
  const workflow = await readFile(
    path.join(projectRoot, ".github", "workflows", "macos-release.yml"),
    "utf8",
  );

  assert.match(workflow, /runs-on: macos-14/);
  assert.doesNotMatch(workflow, /macos-latest/);
  // latest.json 只在 stable 分支上传
  assert.match(workflow, /if: steps\.channel\.outputs\.channel == 'stable'[\s\S]*?latest\.json/);
  // 只看真正执行的行，注释里说明「绝不碰 latest.json」是允许的
  const betaCommands = workflow.slice(workflow.indexOf("发布 beta"))
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(betaCommands, /latest\.json/, "beta must never touch latest.json");
  assert.match(betaCommands, /--prerelease/);
  // 签名与 Gatekeeper 校验必须排在发布之前
  assert.ok(
    workflow.indexOf("spctl --assess") < workflow.indexOf("发布 stable"),
    "Gatekeeper verification must gate the release steps",
  );
  assert.ok(workflow.indexOf("拒绝覆盖已发布的版本") < workflow.indexOf("打包（"));
  assert.match(workflow, /_CodeSignature\/CodeResources/);
});

test("signing degrades to ad-hoc when no Apple identity is configured", async () => {
  const workflow = await readFile(
    path.join(projectRoot, ".github", "workflows", "macos-release.yml"),
    "utf8",
  );

  // 没有 Apple 凭据也必须能发版：两条互斥的打包步骤，由 secret 有没有值来选。
  assert.match(workflow, /if: steps\.signing\.outputs\.mode == 'adhoc'/);
  assert.match(workflow, /if: steps\.signing\.outputs\.mode == 'developer-id'/);
  // 空 secret 是空串而不是「未设置」，不能把它当身份传给 tauri
  assert.match(workflow, /\[ -n "\$APPLE_SIGNING_IDENTITY" \]/);
  // ad-hoc 分支绝不能带上任何 APPLE_* 变量，否则 tauri 会去走签名/公证分支
  const adhocStep = workflow.slice(
    workflow.indexOf("打包（ad-hoc"),
    workflow.indexOf("签名封存与随包二进制自检"),
  )
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(adhocStep, /APPLE_/, "the ad-hoc build must not receive Apple credentials");
  // updater 私钥与 Apple 无关，两条路线都要有，否则 latest.json 的 .sig 是空的
  assert.match(adhocStep, /TAURI_SIGNING_PRIVATE_KEY/);
  // 公证与 stapler 只在 developer-id 路线上跑，但封存自检两条路线都跑
  assert.ok(
    workflow.indexOf("签名封存与随包二进制自检") < workflow.indexOf("发布 stable"),
    "the seal check must gate the release steps",
  );
  assert.ok(
    workflow.indexOf("公证与 Gatekeeper 验证") < workflow.indexOf("发布 stable"),
    "notarization must gate the release steps",
  );
  // ad-hoc 版本必须把首次打开的放行步骤写进 release notes
  for (const note of ["first-launch-adhoc.md", "first-launch-notarized.md"]) {
    assert.match(workflow, new RegExp(`document/release/${note}`), `workflow 必须引用 ${note}`);
  }
  const adhocNote = await readFile(
    path.join(projectRoot, "document", "release", "first-launch-adhoc.md"),
    "utf8",
  );
  // macOS 15 起 Apple 取消了 Control+点击绕过，两种系统的步骤都要写清
  assert.match(adhocNote, /仍要打开/);
  assert.match(adhocNote, /Control/);
  // 带隔离属性直接双击会触发 App Translocation，sidecar 起不来，必须让用户先拖进「应用程序」
  assert.match(adhocNote, /应用程序/);
});

test("the bundle is ad-hoc signed and keeps the entitlements the bundled Node needs", async () => {
  const config = JSON.parse(await readFile(
    path.join(projectRoot, "src-tauri", "tauri.conf.json"),
    "utf8",
  ));
  // 不写 signingIdentity 时 tauri 完全不签，产物只有 linker-signed 的 ad-hoc 签名，
  // 资源不被封存，`codesign --verify --deep --strict` 直接报签名结构不完整。
  assert.equal(config.bundle.macOS.signingIdentity, "-");
  assert.equal(config.bundle.macOS.entitlements, "entitlements.plist");

  const entitlements = await readFile(
    path.join(projectRoot, "src-tauri", "entitlements.plist"),
    "utf8",
  );
  // 只看真正生效的 <key>，注释里提到某个 entitlement 不算数
  const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
  // 打包时 node 会被本项目的身份重签，重签会丢掉 Node 官方的 hardened runtime
  // 例外。缺了这两条，V8 起不来，node 一启动就 EXC_BREAKPOINT / SIGTRAP。
  assert.deepEqual(keys.toSorted(), [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
  ], "get-task-allow 会让 Developer ID 产物在公证时被拒，其余几条本项目用不到");

  for (const workflowName of ["macos-verify.yml", "macos-release.yml"]) {
    const workflow = await readFile(
      path.join(projectRoot, ".github", "workflows", workflowName),
      "utf8",
    );
    assert.match(workflow, /allow-jit/, `${workflowName} must check the entitlement survives signing`);
    assert.match(
      workflow,
      /"\$app\/Contents\/MacOS\/node" -e/,
      `${workflowName} must actually run the bundled node, not just read its entitlements`,
    );
  }
});

test("updater artifacts stay in the release config so local builds need no private key", async () => {
  const base = JSON.parse(await readFile(
    path.join(projectRoot, "src-tauri", "tauri.conf.json"),
    "utf8",
  ));
  const release = JSON.parse(await readFile(
    path.join(projectRoot, "src-tauri", "tauri.release.conf.json"),
    "utf8",
  ));

  // 开着 createUpdaterArtifacts 而没有私钥会让本地 `npx tauri build` 直接失败。
  assert.equal(base.bundle.createUpdaterArtifacts, undefined);
  assert.equal(base.plugins, undefined);
  assert.equal(release.bundle.createUpdaterArtifacts, true);

  // pubkey 只要还是占位符，发出去的更新产物就通不过客户端校验，用户永远收不到
  // 更新——而且这一步失败发生在用户机器上，CI 全绿也看不出来。
  const pubkey = Buffer.from(release.plugins.updater.pubkey, "base64").toString("utf8");
  const [comment, encodedKey] = pubkey.trim().split("\n");
  assert.match(comment, /minisign public key/, "pubkey 必须是 tauri signer generate 产出的公钥");
  const raw = Buffer.from(encodedKey, "base64");
  assert.equal(raw.subarray(0, 2).toString("utf8"), "Ed", "只接受 Ed25519");
  assert.equal(raw.length, 42, "2 字节算法 + 8 字节 key id + 32 字节公钥");

  assert.deepEqual(release.plugins.updater.endpoints, [
    "https://github.com/jkj-jim/agent-taskboard/releases/latest/download/latest.json",
  ]);

  const workflow = await readFile(
    path.join(projectRoot, ".github", "workflows", "macos-release.yml"),
    "utf8",
  );
  assert.match(workflow, /--config src-tauri\/tauri\.release\.conf\.json/);
});
