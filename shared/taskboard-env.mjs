// 环境变量的规范前缀是 `AGENT_TASKBOARD_`，旧前缀 `CODEX_TASKBOARD_` 继续认。
//
// 保留旧名不是为了兼容外部用户（本项目没有），而是因为旧名会留在两处磁盘上：
// 服务为 Agent 生成的 `taskctl` shim 脚本里写死了变量名，而已经跑起来的 Agent
// 会话继承的是当年那份 shim；协作者机器上按 README 配的 shell profile 同理。
// 只认新名会让这些环境在下一次 `taskctl` 调用时静默连到默认端口。

export const ENV_PREFIX = "AGENT_TASKBOARD_";
export const LEGACY_ENV_PREFIX = "CODEX_TASKBOARD_";

/** 规范名与旧名，按优先级排列。`suffix` 不带前缀，如 `"URL"`、`"PORT"`。 */
export function envNames(suffix) {
  return [`${ENV_PREFIX}${suffix}`, `${LEGACY_ENV_PREFIX}${suffix}`];
}

/**
 * 读一个配置项：规范名优先，其次旧名。空串按「没设」处理——
 * shim 或 CI 里把变量置空是常见的「取消设置」写法，不该被当成合法取值。
 */
export function readEnv(suffix, env = process.env) {
  for (const name of envNames(suffix)) {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}
