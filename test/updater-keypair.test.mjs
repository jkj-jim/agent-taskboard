import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { verifyUpdaterSignature } from "../scripts/verify-updater-keypair.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(projectRoot, "scripts", "verify-updater-keypair.mjs");

// 一次性的测试夹具口令。它签的是临时目录里的探针文件，跟发布密钥没有任何关系。
const FIXTURE_PASSWORD = "updater-keypair-fixture";

function boxed(comment, payload) {
  return Buffer.from(`${comment}\n${payload.toString("base64")}\n`, "utf8").toString("base64");
}

function unbox(blob) {
  const lines = Buffer.from(blob.trim(), "base64").toString("utf8").trim().split("\n");
  return { comment: lines[0], payload: Buffer.from(lines[1], "base64") };
}

function withFixtureKeypair(run) {
  const workspace = mkdtempSync(path.join(tmpdir(), "updater-keypair-test-"));
  try {
    const keyPath = path.join(workspace, "fixture.key");
    // generate 不读环境变量，不给 -p 就会去交互式问口令然后 abort
    execFileSync("npx", ["tauri", "signer", "generate", "-f", "-w", keyPath, "-p", FIXTURE_PASSWORD], {
      cwd: projectRoot,
      stdio: ["ignore", "ignore", "inherit"],
    });
    const configPath = path.join(workspace, "release.conf.json");
    // .pub 文件里存的就是配置要填的那串 base64，不需要再包一层
    const pubkey = readFileSync(`${keyPath}.pub`, "utf8").trim();
    const writeConfig = (value) => {
      writeFileSync(configPath, JSON.stringify({ plugins: { updater: { pubkey: value } } }));
    };
    writeConfig(pubkey);
    return run({ workspace, keyPath, configPath, pubkey, writeConfig });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function runScript({ keyPath, configPath }) {
  return execFileSync("node", [script, "--config", configPath], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: FIXTURE_PASSWORD,
    },
  });
}

test("a matching keypair passes end to end through the real tauri signer", () => {
  withFixtureKeypair((fixture) => {
    const output = runScript(fixture);
    assert.match(output, /updater 公私钥成对/);
    // 校验脚本不得回显任何密钥材料
    const secret = readFileSync(fixture.keyPath, "utf8").trim();
    assert.doesNotMatch(output, new RegExp(secret.slice(0, 32)));
  });
});

test("a public key from a different keypair is rejected", () => {
  withFixtureKeypair((fixture) => {
    // 改掉公钥的 key id，模拟配置里填的是另一对密钥的公钥
    const { comment, payload } = unbox(fixture.pubkey);
    const tampered = Buffer.from(payload);
    tampered[2] ^= 0xff;
    fixture.writeConfig(boxed(comment, tampered));

    assert.throws(() => runScript(fixture), (error) => {
      assert.match(error.stderr, /公私钥不是一对/);
      return true;
    });
  });
});

test("a public key whose key id matches but whose bytes differ is rejected", () => {
  withFixtureKeypair((fixture) => {
    // key id 保持一致，只动公钥本体：只比 key id 是不够的，签名必须真的验一遍
    const { comment, payload } = unbox(fixture.pubkey);
    const tampered = Buffer.from(payload);
    tampered[tampered.length - 1] ^= 0xff;
    fixture.writeConfig(boxed(comment, tampered));

    assert.throws(() => runScript(fixture), (error) => {
      assert.match(error.stderr, /签名验不过/);
      return true;
    });
  });
});

test("the shipped public key is the one the App will compile in", () => {
  const config = JSON.parse(readFileSync(
    path.join(projectRoot, "src-tauri", "tauri.release.conf.json"),
    "utf8",
  ));
  const { comment, payload } = unbox(config.plugins.updater.pubkey);
  assert.match(comment, /minisign public key/);
  assert.equal(payload.subarray(0, 2).toString("utf8"), "Ed");
  assert.equal(payload.length, 42);
  // 私钥只在发布者手里，仓库里不得出现任何私钥材料
  assert.doesNotMatch(JSON.stringify(config), /secret key/i);
});

test("verifyUpdaterSignature refuses malformed input instead of passing it through", () => {
  const pubkey = boxed("untrusted comment: minisign public key: 0", Buffer.concat([
    Buffer.from("Ed", "utf8"),
    Buffer.alloc(8),
    Buffer.alloc(32),
  ]));
  const message = Buffer.from("x");

  assert.throws(
    () => verifyUpdaterSignature({ pubkey: "bm90LWJhc2U2NA==", signature: pubkey, message }),
    /公钥格式不对/,
  );
  assert.throws(
    () => verifyUpdaterSignature({
      pubkey,
      signature: boxed("untrusted comment: x", Buffer.concat([
        Buffer.from("Ed", "utf8"),
        Buffer.alloc(8),
        Buffer.alloc(8),
      ])),
      message,
    }),
    /签名应为 64 字节/,
  );
});
