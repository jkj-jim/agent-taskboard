import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { APP_VERSION_FULL } from "../shared/app-version.generated.mjs";
import {
  DEVELOPMENT_HOST,
  DEVELOPMENT_PORT,
  SIDECAR_PARAMETERS,
  parseSidecarArgv,
} from "../server/sidecar-options.mjs";

const projectRoot = "/repo";
const appDataRoot = "/Users/somebody/Library/Application Support/io.github.jkj-jim.agenttaskboard";

// 安装版的 App Data 路径带空格，所有断言都用它，确保没有人靠 split(" ") 解析。
function installedArgv(overrides = {}) {
  const values = {
    "--profile": "production",
    "--app-version": APP_VERSION_FULL,
    "--host": "127.0.0.1",
    "--port": "47824",
    "--data-directory": `${appDataRoot}/profiles/production/data`,
    "--attachments-directory": `${appDataRoot}/profiles/production/attachments`,
    "--runtime-directory": `${appDataRoot}/profiles/production/runtime`,
    "--static-directory": "/Applications/Agent Taskboard.app/Contents/Resources/dist/web",
    "--skill-path": "/Users/somebody/.agents/skills/manage-taskboard/SKILL.md",
    "--taskctl-cli-path": "/Applications/Agent Taskboard.app/Contents/Resources/cli/taskctl.mjs",
    ...overrides,
  };
  return Object.entries(values)
    .filter(([, value]) => value !== null)
    .flatMap(([flag, value]) => [flag, value]);
}

test("the ten installed parameters land on listen and server options", () => {
  assert.equal(SIDECAR_PARAMETERS.length, 10);

  const parsed = parseSidecarArgv(installedArgv(), { env: {}, projectRoot });

  assert.equal(parsed.mode, "installed");
  assert.deepEqual(parsed.listen, { host: "127.0.0.1", port: 47824 });
  assert.deepEqual(parsed.options, {
    profile: "production",
    appVersion: APP_VERSION_FULL,
    dataDirectory: `${appDataRoot}/profiles/production/data`,
    attachmentsDirectory: `${appDataRoot}/profiles/production/attachments`,
    runtimeDirectory: `${appDataRoot}/profiles/production/runtime`,
    staticDirectory: "/Applications/Agent Taskboard.app/Contents/Resources/dist/web",
    skillPath: "/Users/somebody/.agents/skills/manage-taskboard/SKILL.md",
    taskctlCliPath: "/Applications/Agent Taskboard.app/Contents/Resources/cli/taskctl.mjs",
  });
});

test("paths containing spaces survive parsing untouched", () => {
  const parsed = parseSidecarArgv(installedArgv(), { env: {}, projectRoot });
  for (const value of [parsed.options.staticDirectory, parsed.options.taskctlCliPath]) {
    assert.ok(value.includes("Agent Taskboard.app"), value);
  }
  assert.ok(parsed.options.dataDirectory.includes("Application Support"));
});

test("--flag=value is accepted alongside --flag value", () => {
  const pairs = installedArgv();
  const equalsForm = [];
  for (let index = 0; index < pairs.length; index += 2) {
    equalsForm.push(`${pairs[index]}=${pairs[index + 1]}`);
  }

  const parsed = parseSidecarArgv(equalsForm, { env: {}, projectRoot });
  assert.equal(parsed.mode, "installed");
  assert.deepEqual(parsed.options, parseSidecarArgv(pairs, { env: {}, projectRoot }).options);
});

test("installed startup refuses to fall back to the repository root", () => {
  assert.throws(
    () => parseSidecarArgv(installedArgv({ "--static-directory": null }), { env: {}, projectRoot }),
    /--static-directory/,
  );
  assert.throws(
    () => parseSidecarArgv(installedArgv({ "--taskctl-cli-path": null }), { env: {}, projectRoot }),
    /--taskctl-cli-path/,
  );
  assert.throws(
    () => parseSidecarArgv(installedArgv({ "--runtime-directory": null }), { env: {}, projectRoot }),
    /--runtime-directory/,
  );
  assert.throws(
    () => parseSidecarArgv(installedArgv({ "--skill-path": null }), { env: {}, projectRoot }),
    /--skill-path/,
  );
});

test("environment variables cannot stand in for a missing installed parameter", () => {
  assert.throws(
    () => parseSidecarArgv(installedArgv({ "--static-directory": null }), {
      env: { AGENT_TASKBOARD_STATIC_DIR: "/somewhere/web" },
      projectRoot,
    }),
    /--static-directory/,
  );
});

test("profile and app version must be paired", () => {
  assert.throws(
    () => parseSidecarArgv(installedArgv({ "--app-version": null }), { env: {}, projectRoot }),
    /--app-version/,
  );
  assert.throws(
    () => parseSidecarArgv(installedArgv({ "--profile": null }), { env: {}, projectRoot }),
    /--profile/,
  );
});

test("the version handshake rejects a mismatched shell or profile", () => {
  assert.throws(
    () => parseSidecarArgv(installedArgv({ "--app-version": "9.9.9" }), {
      env: {},
      projectRoot,
      expectedVersion: APP_VERSION_FULL,
    }),
    /handshake failed/,
  );

  assert.throws(
    () => parseSidecarArgv(installedArgv({ "--profile": "beta" }), {
      env: {},
      projectRoot,
      expectedVersion: "1.2.3",
    }),
    /handshake failed/,
  );

  assert.throws(
    () => parseSidecarArgv(installedArgv({
      "--profile": "beta",
      "--app-version": "1.2.3",
    }), { env: {}, projectRoot, expectedVersion: "1.2.3" }),
    /belongs to the production profile/,
  );

  assert.throws(
    () => parseSidecarArgv(installedArgv({ "--profile": "development" }), { env: {}, projectRoot }),
    /must be one of/,
  );
});

test("development startup falls back to repository paths", () => {
  const parsed = parseSidecarArgv([], { env: {}, projectRoot });

  assert.equal(parsed.mode, "development");
  assert.deepEqual(parsed.listen, { host: DEVELOPMENT_HOST, port: DEVELOPMENT_PORT });
  assert.equal(parsed.options.profile, null);
  assert.equal(parsed.options.dataDirectory, path.join(projectRoot, ".data"));
  assert.equal(parsed.options.runtimeDirectory, path.join(projectRoot, ".data", "runtime"));
  assert.equal(parsed.options.staticDirectory, path.join(projectRoot, "dist", "web"));
  assert.equal(parsed.options.taskctlCliPath, path.join(projectRoot, "cli", "taskctl.mjs"));
});

test("CLI beats environment, environment beats the development default", () => {
  const env = {
    AGENT_TASKBOARD_PORT: "51000",
    AGENT_TASKBOARD_HOST: "127.0.0.1",
    AGENT_TASKBOARD_DATA_DIR: "/from/env",
    AGENT_TASKBOARD_SKILL_PATH: "/from/env/SKILL.md",
  };

  const fromEnv = parseSidecarArgv([], { env, projectRoot });
  assert.deepEqual(fromEnv.listen, { host: "127.0.0.1", port: 51000 });
  assert.equal(fromEnv.options.dataDirectory, "/from/env");
  assert.equal(fromEnv.options.skillPath, "/from/env/SKILL.md");
  // 未被环境变量覆盖的项仍然落到开发版默认值
  assert.equal(fromEnv.options.staticDirectory, path.join(projectRoot, "dist", "web"));

  const fromCli = parseSidecarArgv(["--port", "52000", "--data-directory", "/from/cli"], {
    env,
    projectRoot,
  });
  assert.equal(fromCli.listen.port, 52000);
  assert.equal(fromCli.options.dataDirectory, "/from/cli");
  // 未在 CLI 上出现的项继续由环境变量提供
  assert.equal(fromCli.options.skillPath, "/from/env/SKILL.md");
});

test("attachments and runtime default inside the resolved data directory", () => {
  const parsed = parseSidecarArgv(["--data-directory", "/custom/data"], { env: {}, projectRoot });
  assert.equal(parsed.options.attachmentsDirectory, path.join("/custom/data", "attachments"));
  assert.equal(parsed.options.runtimeDirectory, path.join("/custom/data", "runtime"));
});

test("malformed argv is rejected instead of silently ignored", () => {
  assert.throws(() => parseSidecarArgv(["--nope", "x"], { env: {}, projectRoot }), /Unknown sidecar option/);
  assert.throws(() => parseSidecarArgv(["--port"], { env: {}, projectRoot }), /requires a value/);
  assert.throws(
    () => parseSidecarArgv(["--port", "--host", "127.0.0.1"], { env: {}, projectRoot }),
    /requires a value/,
  );
  assert.throws(
    () => parseSidecarArgv(["--port", "1", "--port", "2"], { env: {}, projectRoot }),
    /more than once/,
  );
  assert.throws(() => parseSidecarArgv(["--port", "0"], { env: {}, projectRoot }), /between 1 and 65535/);
  assert.throws(() => parseSidecarArgv(["--host", "0.0.0.1"], { env: {}, projectRoot }), /127\.0\.0\.1 or 0\.0\.0\.0/);
});

test("the development flag used by npm run dev is accepted", () => {
  const parsed = parseSidecarArgv(["--dev"], { env: {}, projectRoot });
  assert.equal(parsed.development, true);
  assert.equal(parsed.mode, "development");
});
