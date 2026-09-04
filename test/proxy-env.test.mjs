import assert from "node:assert/strict";
import test from "node:test";

import { parseScutilProxy, withProxyEnv } from "../server/agents/proxy-env.mjs";

const SCUTIL_OUTPUT = `<dictionary> {
  ExceptionsList : <array> {
    0 : localhost
    1 : 127.0.0.0/8
  }
  HTTPEnable : 1
  HTTPPort : 10808
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 10808
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
}`;

function scutil(stdout) {
  return async (file, args) => {
    assert.equal(file, "scutil");
    assert.deepEqual(args, ["--proxy"]);
    return { stdout };
  };
}

const alwaysReachable = async () => true;
const neverReachable = async () => false;

test("parses the SystemConfiguration dictionary and ignores disabled entries", () => {
  assert.deepEqual(parseScutilProxy(SCUTIL_OUTPUT), {
    http: { host: "127.0.0.1", port: 10808 },
    https: { host: "127.0.0.1", port: 10808 },
  });
  assert.deepEqual(
    parseScutilProxy("<dictionary> {\n  HTTPEnable : 0\n  HTTPProxy : 127.0.0.1\n  HTTPPort : 1\n}"),
    { http: null, https: null },
  );
  // 端口缺失或越界的条目不成立，不能拼出 `http://host:NaN`。
  assert.deepEqual(
    parseScutilProxy("<dictionary> {\n  HTTPEnable : 1\n  HTTPProxy : 127.0.0.1\n}"),
    { http: null, https: null },
  );
});

test("injects the system proxy when the launchd environment has none", async () => {
  const env = await withProxyEnv(
    { PATH: "/usr/bin:/bin" },
    { runCommand: scutil(SCUTIL_OUTPUT), checkReachable: alwaysReachable },
  );
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:10808");
  assert.equal(env.https_proxy, "http://127.0.0.1:10808");
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:10808");
  assert.equal(env.http_proxy, "http://127.0.0.1:10808");
  // taskctl 要回访 http://127.0.0.1:<port>，本机地址必须绕过代理。
  assert.match(env.NO_PROXY, /127\.0\.0\.1/);
  assert.match(env.no_proxy, /localhost/);
  assert.equal(env.PATH, "/usr/bin:/bin");
});

test("an environment that already has a proxy is returned untouched", async () => {
  const existing = { HTTPS_PROXY: "http://127.0.0.1:7897", no_proxy: "localhost" };
  const env = await withProxyEnv(existing, {
    runCommand: async () => assert.fail("scutil must not run when the env already has a proxy"),
    checkReachable: alwaysReachable,
  });
  assert.equal(env, existing);
});

test("a configured but dead proxy is not injected", async () => {
  const env = await withProxyEnv(
    { PATH: "/usr/bin" },
    { runCommand: scutil(SCUTIL_OUTPUT), checkReachable: neverReachable },
  );
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.NO_PROXY, undefined);
});

test("no system proxy and an unavailable scutil both leave the environment alone", async () => {
  const none = await withProxyEnv(
    { PATH: "/usr/bin" },
    { runCommand: scutil("<dictionary> {\n  HTTPEnable : 0\n}"), checkReachable: alwaysReachable },
  );
  assert.equal(none.HTTPS_PROXY, undefined);

  const failed = await withProxyEnv(
    { PATH: "/usr/bin" },
    {
      runCommand: async () => { throw new Error("spawn scutil ENOENT"); },
      checkReachable: alwaysReachable,
    },
  );
  assert.equal(failed.HTTPS_PROXY, undefined);
});
