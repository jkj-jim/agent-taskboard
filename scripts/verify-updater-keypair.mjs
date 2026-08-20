#!/usr/bin/env node
// 校验 updater 私钥与编译进 App 的公钥确实是一对。
//
// 这是唯一会「静默」失败的环节：私钥口令错了 `tauri build` 会直接报错，但公私钥
// 不成对时打包照样成功、latest.json 照样发出去，客户端却会在校验签名那一步全部
// 拒绝——而且这一步发生在用户机器上，CI 全绿也看不出来。已装旧版本的用户从此
// 收不到任何更新，只能手动重装。
//
// 做法：用私钥真的签一次已知内容，再用配置里的公钥验一次。签名不是秘密，全程
// 不打印任何密钥材料。私钥与口令只经环境变量转发给 tauri CLI，不进 argv。
//
//   TAURI_SIGNING_PRIVATE_KEY=<私钥文件内容> \
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<口令> \
//   node scripts/verify-updater-keypair.mjs
//
// 本地也可以用文件代替字符串：TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/xxx.key

import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Ed25519 裸公钥外面要套一层 SPKI 才能进 createPublicKey
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function parseBoxedKey(base64Blob, what) {
  // 公钥文件、私钥文件和 .sig 都是同一种包装：整体 base64，解开是
  // 「untrusted comment: …\n<base64 载荷>」。
  const decoded = Buffer.from(base64Blob.trim(), "base64").toString("utf8");
  const lines = decoded.trim().split("\n");
  if (lines.length < 2) throw new Error(`${what}格式不对：解码后不足两行`);
  const payload = Buffer.from(lines[1].trim(), "base64");
  return { comment: lines[0], algorithm: payload.subarray(0, 2).toString("utf8"), keyId: payload.subarray(2, 10), body: payload.subarray(10) };
}

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

export function verifyUpdaterSignature({ pubkey, signature, message }) {
  const publicKey = parseBoxedKey(pubkey, "公钥");
  if (publicKey.algorithm !== "Ed") throw new Error(`只支持 Ed25519 公钥，读到 ${publicKey.algorithm}`);
  if (publicKey.body.length !== 32) throw new Error(`公钥应为 32 字节，读到 ${publicKey.body.length}`);

  const signed = parseBoxedKey(signature, "签名");
  if (signed.body.length !== 64) throw new Error(`签名应为 64 字节，读到 ${signed.body.length}`);
  if (!signed.keyId.equals(publicKey.keyId)) {
    throw new Error(
      `公私钥不是一对：签名来自 key id ${signed.keyId.toString("hex")}，`
      + `配置里的公钥是 ${publicKey.keyId.toString("hex")}`,
    );
  }

  // minisign 的 "ED" 是先做 Blake2b-512 再签，"Ed" 直接签原文
  const digested = signed.algorithm === "ED"
    ? createHash("blake2b512").update(message).digest()
    : message;
  const key = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, publicKey.body]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, digested, key, signed.body)) {
    throw new Error("key id 对得上但签名验不过，私钥或签名产物已损坏");
  }
  return { keyId: publicKey.keyId.toString("hex"), algorithm: signed.algorithm };
}

function main() {
  const configPath = argValue("--config", "src-tauri/tauri.release.conf.json");
  const pubkey = JSON.parse(readFileSync(configPath, "utf8")).plugins?.updater?.pubkey;
  if (!pubkey) throw new Error(`${configPath} 里没有 plugins.updater.pubkey`);

  const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  const keyValue = process.env.TAURI_SIGNING_PRIVATE_KEY;
  if (!keyPath && !keyValue) {
    throw new Error("需要 TAURI_SIGNING_PRIVATE_KEY 或 TAURI_SIGNING_PRIVATE_KEY_PATH");
  }

  const workspace = mkdtempSync(path.join(tmpdir(), "updater-keypair-"));
  try {
    const target = path.join(workspace, "probe.bin");
    // 内容任意，只要签名和验证看到的是同一份字节
    const message = Buffer.from("agent-taskboard updater keypair probe\n", "utf8");
    writeFileSync(target, message);

    // 私钥与口令只走 env，不进 argv：argv 在 `ps` 里是所有人可见的
    execFileSync("npx", ["tauri", "signer", "sign", target], {
      // stdin 保持连通：没给 TAURI_SIGNING_PRIVATE_KEY_PASSWORD 时 CLI 会交互式
      // 问口令，本地手动跑就不必把口令放进环境变量或 shell 历史。
      stdio: ["inherit", "ignore", "inherit"],
      env: keyPath
        ? { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath }
        : process.env,
    });

    const result = verifyUpdaterSignature({
      pubkey,
      signature: readFileSync(`${target}.sig`, "utf8"),
      message,
    });
    console.log(`updater 公私钥成对：key id ${result.keyId}（${result.algorithm}）`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

// 仓库路径里有非 ASCII（个人/），`file://${argv[1]}` 拼出来的串跟 import.meta.url
// 的百分号编码对不上，main() 会被静默跳过、脚本以 0 退出。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`updater 密钥校验失败：${error.message}`);
    process.exit(1);
  }
}
