import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ENV_PREFIX, LEGACY_ENV_PREFIX } from "../../shared/taskboard-env.mjs";

export function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Agents call the board through `taskctl`, so the board provisions the command
 * itself instead of depending on a global `npm link`. Each service instance
 * writes it once on first Agent use so it points at this checkout and origin.
 */
export async function ensureTaskctlBin({
  binDirectory,
  cliPath,
  taskboardUrl,
  nodePath = process.execPath,
}) {
  if (typeof taskboardUrl !== "string" || taskboardUrl.length === 0) {
    throw new Error("Taskboard URL is required before creating the taskctl shim");
  }
  await mkdir(binDirectory, { recursive: true });
  const shimPath = path.join(binDirectory, "taskctl");
  await writeFile(
    shimPath,
    `#!/bin/sh\n${ENV_PREFIX}URL=${shellQuote(taskboardUrl)} exec ${shellQuote(nodePath)} ${shellQuote(cliPath)} "$@"\n`,
    { mode: 0o755 },
  );
  return binDirectory;
}

export function withTaskctlOnPath(env, binDirectory) {
  return {
    ...env,
    PATH: [binDirectory, env.PATH].filter(Boolean).join(path.delimiter),
  };
}

export function createTaskctlRuntime({
  binDirectory,
  cliPath,
  nodePath = process.execPath,
  ensureBin = ensureTaskctlBin,
}) {
  let taskboardUrl = null;
  let taskctlBinReady = null;

  function initialize(origin) {
    if (taskboardUrl !== null) {
      throw new Error("Taskctl runtime is already initialized");
    }
    taskboardUrl = origin;
  }

  function currentOrigin() {
    if (taskboardUrl === null) {
      throw new Error("Taskctl runtime is not initialized; listen for the Taskboard port first");
    }
    return taskboardUrl;
  }

  function ensureReady() {
    const origin = currentOrigin();
    taskctlBinReady ??= ensureBin({
      binDirectory,
      cliPath,
      taskboardUrl: origin,
      nodePath,
    });
    return taskctlBinReady;
  }

  async function environment(baseEnv) {
    const origin = currentOrigin();
    // 旧名要显式删掉而不是留着。规范名优先，留着也不会读错，但 Agent 子进程会
    // 看到两个互相矛盾的地址；一旦有人照旧名调试，拿到的就是上一个实例的端口。
    const { [`${LEGACY_ENV_PREFIX}URL`]: _legacyUrl, ...inherited } = baseEnv;
    return withTaskctlOnPath(
      { ...inherited, [`${ENV_PREFIX}URL`]: origin },
      await ensureReady(),
    );
  }

  async function shimPath() {
    return path.join(await ensureReady(), "taskctl");
  }

  return {
    initialize,
    currentOrigin,
    ensureReady,
    environment,
    shimPath,
  };
}
