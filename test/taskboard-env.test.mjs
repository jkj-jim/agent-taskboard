import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ENV_PREFIX, LEGACY_ENV_PREFIX, envNames, readEnv } from "../shared/taskboard-env.mjs";
import { parseSidecarArgv } from "../server/sidecar-options.mjs";
import { resolveHost, resolvePort } from "../server/app.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the canonical prefix wins and the legacy one still works", () => {
  assert.deepEqual(envNames("URL"), ["AGENT_TASKBOARD_URL", "CODEX_TASKBOARD_URL"]);

  assert.equal(readEnv("URL", { AGENT_TASKBOARD_URL: "new" }), "new");
  assert.equal(readEnv("URL", { CODEX_TASKBOARD_URL: "old" }), "old");
  assert.equal(
    readEnv("URL", { AGENT_TASKBOARD_URL: "new", CODEX_TASKBOARD_URL: "old" }),
    "new",
    "两个都在时规范名优先",
  );
  assert.equal(readEnv("URL", {}), undefined);
});

test("an empty value counts as unset, not as a legal one", () => {
  // shim 与 CI 里「置空等于取消设置」是常见写法。空串当合法值会让 new URL("") 抛，
  // 或者让端口解析成 NaN，报出来的错跟真正的原因隔着一层。
  assert.equal(readEnv("URL", { AGENT_TASKBOARD_URL: "" }), undefined);
  assert.equal(
    readEnv("URL", { AGENT_TASKBOARD_URL: "", CODEX_TASKBOARD_URL: "old" }),
    "old",
    "规范名被置空时要能落到旧名上",
  );
});

test("the sidecar reads both prefixes for every env-backed parameter", () => {
  const canonical = parseSidecarArgv([], {
    env: {
      [`${ENV_PREFIX}HOST`]: "127.0.0.1",
      [`${ENV_PREFIX}PORT`]: "51000",
      [`${ENV_PREFIX}DATA_DIR`]: "/from/env",
    },
    projectRoot,
  });
  const legacy = parseSidecarArgv([], {
    env: {
      [`${LEGACY_ENV_PREFIX}HOST`]: "127.0.0.1",
      [`${LEGACY_ENV_PREFIX}PORT`]: "51000",
      [`${LEGACY_ENV_PREFIX}DATA_DIR`]: "/from/env",
    },
    projectRoot,
  });

  assert.deepEqual(canonical.listen, { host: "127.0.0.1", port: 51000 });
  assert.equal(canonical.options.dataDirectory, "/from/env");
  assert.deepEqual(legacy.listen, canonical.listen);
  assert.equal(legacy.options.dataDirectory, canonical.options.dataDirectory);

  // 两个前缀同时出现时规范名赢
  const both = parseSidecarArgv([], {
    env: {
      [`${ENV_PREFIX}PORT`]: "51000",
      [`${LEGACY_ENV_PREFIX}PORT`]: "52000",
    },
    projectRoot,
  });
  assert.equal(both.listen.port, 51000);
});

test("the server resolvers accept both prefixes and name the canonical one when rejecting", () => {
  assert.equal(resolvePort("51000"), 51000);
  assert.throws(() => resolvePort("not-a-port"), /AGENT_TASKBOARD_PORT/);
  assert.throws(() => resolveHost("10.0.0.1"), /AGENT_TASKBOARD_HOST/);
});

test("no source file reads a legacy env name directly", async () => {
  // 旧名只应该出现在 shared/taskboard-env.mjs 这一处。散落在各处的 process.env
  // 直读会绕过优先级，出现「一半认新名一半认旧名」的状态。
  const roots = ["server", "shared", "cli", "scripts"];
  const offenders = [];

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(location);
        continue;
      }
      if (!entry.name.endsWith(".mjs")) continue;
      const relative = path.relative(projectRoot, location);
      if (relative === path.join("shared", "taskboard-env.mjs")) continue;
      const source = await readFile(location, "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        // 注释里提到旧名是可以的，代码里直读不行
        if (line.trim().startsWith("//")) continue;
        if (/\bCODEX_TASKBOARD_[A-Z_]+\b/.test(line) && !/__CODEX_TASKBOARD_/.test(line)) {
          offenders.push(`${relative}:${index + 1}`);
        }
      }
    }
  }

  for (const root of roots) await walk(path.join(projectRoot, root));
  assert.deepEqual(offenders, []);
});
