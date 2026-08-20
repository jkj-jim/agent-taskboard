// App 版本与 profile 的唯一判定逻辑（document/design/desktop-app-packaging.md §4、§5）。
// 完整 SemVer 只有一个来源：package.json#version，由 scripts/sync-app-version.mjs
// 生成到 app-version.generated.mjs 和 src-tauri/src/app_version_generated.rs。
// 运行时不得从 Info.plist、文件名、Git tag、updater 响应或 package.json 现读版本。

// 本模块只放判定逻辑，不导入生成文件：生成器自己要用这些函数，反向依赖会让首次生成死锁。
// 需要常量的一方直接 import "./app-version.generated.mjs"。

export const PROFILE_PRODUCTION = "production";
export const PROFILE_BETA = "beta";
export const APP_PROFILES = [PROFILE_PRODUCTION, PROFILE_BETA];

// 官方 SemVer 正则，但不接受 build metadata：只差 `+xxx` 的两个版本对 updater
// 是同一个版本，允许它等于允许发布两个无法区分的产物。
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export function parseAppVersion(version) {
  if (typeof version !== "string") {
    throw new Error("App version must be a string");
  }
  if (version.includes("+")) {
    throw new Error(
      `App version must not carry build metadata: ${version}；只差 build metadata 的版本对 updater 无法区分`,
    );
  }
  const match = SEMVER_PATTERN.exec(version);
  if (!match) {
    throw new Error(`App version must be a complete SemVer without a leading v, got: ${version}`);
  }
  const [, major, minor, patch, prerelease] = match;
  return {
    version,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
  };
}

// 构建时固定：无 pre-release 标记发 production，有则发 beta，运行时不可切换。
export function profileForVersion(version) {
  return parseAppVersion(version).prerelease === null ? PROFILE_PRODUCTION : PROFILE_BETA;
}

export function assertAppProfile(profile) {
  if (!APP_PROFILES.includes(profile)) {
    throw new Error(`App profile must be one of ${APP_PROFILES.join(", ")}, got: ${profile}`);
  }
  return profile;
}

// Tauri 与 sidecar 的启动握手：两端的完整版本字符串必须逐字符相等，
// 且该版本推导出的 profile 必须与传入的 profile 一致。
export function assertAppVersionHandshake({ appVersion, profile, expectedVersion }) {
  parseAppVersion(expectedVersion);
  if (appVersion !== expectedVersion) {
    throw new Error(
      `App version handshake failed: shell reported ${appVersion}, sidecar was built as ${expectedVersion}`,
    );
  }
  assertAppProfile(profile);
  const derived = profileForVersion(appVersion);
  if (derived !== profile) {
    throw new Error(
      `App version ${appVersion} belongs to the ${derived} profile, but ${profile} was requested`,
    );
  }
  return { appVersion, profile };
}
