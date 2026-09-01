// Tauri 壳启动 sidecar 时传入的十一个参数（document/design/desktop-app-packaging.md §4）。
// 优先级固定为：CLI 参数 > AGENT_TASKBOARD_*（旧名 CODEX_TASKBOARD_* 仍认）> 开发版默认值。
// 安装版（带 --profile）必须显式传满十一个，缺任何一个都立即报错，绝不回退到 PROJECT_ROOT。

import path from "node:path";

import { APP_VERSION_FULL } from "../shared/app-version.generated.mjs";
import { assertAppProfile, assertAppVersionHandshake } from "../shared/app-version.mjs";
import { readEnv } from "../shared/taskboard-env.mjs";

export const DEVELOPMENT_PORT = 47823;
export const DEVELOPMENT_HOST = "0.0.0.0";

export const SIDECAR_PARAMETERS = [
  // profile 与 app-version 是构建期握手，只能由壳传入，不接受环境变量覆盖。
  { flag: "--profile", key: "profile", kind: "profile" },
  { flag: "--app-version", key: "appVersion", kind: "version" },
  { flag: "--host", key: "host", kind: "host", env: "HOST" },
  { flag: "--port", key: "port", kind: "port", env: "PORT" },
  { flag: "--data-directory", key: "dataDirectory", kind: "path", env: "DATA_DIR" },
  {
    flag: "--attachments-directory",
    key: "attachmentsDirectory",
    kind: "path",
    env: "ATTACHMENTS_DIR",
  },
  {
    flag: "--runtime-directory",
    key: "runtimeDirectory",
    kind: "path",
    env: "RUNTIME_DIR",
  },
  {
    flag: "--static-directory",
    key: "staticDirectory",
    kind: "path",
    env: "STATIC_DIR",
  },
  { flag: "--skill-path", key: "skillPath", kind: "path", env: "SKILL_PATH" },
  {
    flag: "--taskctl-cli-path",
    key: "taskctlCliPath",
    kind: "path",
    env: "TASKCTL_CLI_PATH",
  },
  {
    flag: "--codex-injector-path",
    key: "codexInjectorPath",
    kind: "path",
    env: "CODEX_INJECTOR_PATH",
  },
];

// `npm run dev:server` 一直带着它；显式接受，避免开发命令被参数校验挡下。
const DEVELOPMENT_FLAG = "--dev";

const parametersByFlag = new Map(SIDECAR_PARAMETERS.map((parameter) => [parameter.flag, parameter]));

function readArgv(argv) {
  const values = new Map();
  let development = false;

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === DEVELOPMENT_FLAG) {
      development = true;
      continue;
    }
    const separator = entry.indexOf("=");
    const flag = separator === -1 ? entry : entry.slice(0, separator);
    const parameter = parametersByFlag.get(flag);
    if (!parameter) {
      throw new Error(`Unknown sidecar option: ${flag}`);
    }
    if (values.has(parameter.key)) {
      throw new Error(`${flag} was passed more than once`);
    }
    const value = separator === -1 ? argv[++index] : entry.slice(separator + 1);
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    values.set(parameter.key, value);
  }

  return { values, development };
}

function coerce(parameter, raw) {
  switch (parameter.kind) {
    case "profile":
      return assertAppProfile(raw);
    case "version":
      return raw;
    case "host":
      if (raw !== "127.0.0.1" && raw !== "0.0.0.0") {
        throw new Error(`${parameter.flag} must be 127.0.0.1 or 0.0.0.0, got: ${raw}`);
      }
      return raw;
    case "port": {
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${parameter.flag} must be an integer between 1 and 65535, got: ${raw}`);
      }
      return port;
    }
    case "path": {
      if (raw.trim().length === 0) {
        throw new Error(`${parameter.flag} must not be empty`);
      }
      // 含空格的 App Data 路径必须原样保留，只做绝对化。
      return path.resolve(raw);
    }
    default:
      throw new Error(`Unhandled sidecar option kind: ${parameter.kind}`);
  }
}

/**
 * 把 sidecar 的 argv 转换成 `app.listen()` 与 `createTaskboardServer()` 的入参。
 * `projectRoot` 只服务于 `npm run dev` 和测试；安装版永远不会走到这些默认值。
 */
export function parseSidecarArgv(argv, {
  env = process.env,
  projectRoot,
  expectedVersion = APP_VERSION_FULL,
} = {}) {
  const { values, development } = readArgv(argv);

  const resolved = {};
  for (const parameter of SIDECAR_PARAMETERS) {
    const raw = values.has(parameter.key)
      ? values.get(parameter.key)
      : (parameter.env ? readEnv(parameter.env, env) : undefined);
    resolved[parameter.key] = raw === undefined || raw === "" ? null : coerce(parameter, raw);
  }

  const installed = resolved.profile !== null || resolved.appVersion !== null;
  if (installed) {
    const missing = SIDECAR_PARAMETERS
      .filter((parameter) => !values.has(parameter.key))
      .map((parameter) => parameter.flag);
    if (missing.length > 0) {
      throw new Error(
        `安装版启动必须显式传入全部十一个参数，缺少：${missing.join(", ")}；`
        + "缺失时不回退到仓库路径。",
      );
    }
    // 版本握手必须在打开 SQLite 之前完成，避免壳与 sidecar 资源版本错配。
    assertAppVersionHandshake({
      appVersion: resolved.appVersion,
      profile: resolved.profile,
      expectedVersion,
    });
  }

  const dataDirectory = resolved.dataDirectory ?? path.join(projectRoot, ".data");
  return {
    mode: installed ? "installed" : "development",
    development,
    listen: {
      host: resolved.host ?? DEVELOPMENT_HOST,
      port: resolved.port ?? DEVELOPMENT_PORT,
    },
    options: {
      profile: resolved.profile,
      appVersion: resolved.appVersion ?? expectedVersion,
      dataDirectory,
      attachmentsDirectory: resolved.attachmentsDirectory ?? path.join(dataDirectory, "attachments"),
      runtimeDirectory: resolved.runtimeDirectory ?? path.join(dataDirectory, "runtime"),
      staticDirectory: resolved.staticDirectory ?? path.join(projectRoot, "dist", "web"),
      skillPath: resolved.skillPath
        ?? path.join(projectRoot, "skills", "manage-taskboard", "SKILL.md"),
      taskctlCliPath: resolved.taskctlCliPath ?? path.join(projectRoot, "cli", "taskctl.mjs"),
      // 看板自己拉起 Codex 桥接时要跑的注入器；安装版指向 Resources/scripts。
      codexInjectorPath: resolved.codexInjectorPath
        ?? path.join(projectRoot, "scripts", "codex-injector.mjs"),
    },
  };
}
