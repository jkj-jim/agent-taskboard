// App 版本与 profile 推导（document/design/desktop-app-packaging.md §4、§5）。
// 唯一来源是 package.json#version，经 scripts/sync-app-version.mjs 生成到
// app_version_generated.rs。运行时不读 Info.plist 的 CFBundleShortVersionString：
// 打包工具可能把它规范化，pre-release 标记会丢，profile 判断随之失效。

include!("app_version_generated.rs");

pub const PROFILE_PRODUCTION: &str = "production";
pub const PROFILE_BETA: &str = "beta";

pub const PORT_PRODUCTION: u16 = 47824;
pub const PORT_BETA: u16 = 47825;

/// 构建时固定：无 pre-release 标记发 production，有则发 beta，运行时不可切换。
pub fn profile_for(version: &str) -> &'static str {
    if version.contains('-') {
        PROFILE_BETA
    } else {
        PROFILE_PRODUCTION
    }
}

pub fn profile() -> &'static str {
    profile_for(APP_VERSION_FULL)
}

pub fn port_for(profile: &str) -> u16 {
    if profile == PROFILE_BETA {
        PORT_BETA
    } else {
        PORT_PRODUCTION
    }
}

pub fn port() -> u16 {
    port_for(profile())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_versions_use_the_production_profile() {
        assert_eq!(profile_for("0.1.0"), PROFILE_PRODUCTION);
        assert_eq!(profile_for("2.1.0"), PROFILE_PRODUCTION);
        assert_eq!(port_for(profile_for("2.1.0")), PORT_PRODUCTION);
    }

    #[test]
    fn pre_release_versions_use_the_beta_profile() {
        assert_eq!(profile_for("2.1.0-beta.1"), PROFILE_BETA);
        assert_eq!(profile_for("2.1.0-rc.1"), PROFILE_BETA);
        assert_eq!(port_for(profile_for("2.1.0-beta.1")), PORT_BETA);
    }

    // pre-release 编号必须逐字符保留，否则 beta.1 和 beta.2 会被当成同一个版本。
    #[test]
    fn pre_release_builds_stay_distinguishable() {
        assert_ne!("2.1.0-beta.1", "2.1.0-beta.2");
        assert_eq!(profile_for("2.1.0-beta.1"), profile_for("2.1.0-beta.2"));
    }

    #[test]
    fn the_generated_constant_is_a_usable_version() {
        assert!(!APP_VERSION_FULL.is_empty());
        assert!(!APP_VERSION_FULL.starts_with('v'));
        assert_eq!(APP_VERSION_FULL.split('.').count() >= 3, true);
    }
}
