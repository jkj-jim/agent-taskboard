import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  APP_PROFILES,
  PROFILE_BETA,
  PROFILE_PRODUCTION,
  assertAppProfile,
  assertAppVersionHandshake,
  parseAppVersion,
  profileForVersion,
} from "../shared/app-version.mjs";
import { APP_ID, singleInstanceKey } from "../shared/app-identity.mjs";
import { APP_VERSION_FULL } from "../shared/app-version.generated.mjs";
import {
  renderEsmConstant,
  renderRustConstant,
  replaceCargoVersion,
  replaceJsonVersion,
} from "../scripts/sync-app-version.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a complete SemVer parses into its parts", () => {
  assert.deepEqual(parseAppVersion("2.1.0"), {
    version: "2.1.0",
    major: 2,
    minor: 1,
    patch: 0,
    prerelease: null,
  });
  assert.equal(parseAppVersion("2.1.0-beta.1").prerelease, "beta.1");
});

test("incomplete, prefixed or build-tagged versions are rejected", () => {
  for (const version of ["2.1", "v2.1.0", "2.1.0.1", "", "latest", "01.2.3"]) {
    assert.throws(() => parseAppVersion(version), /complete SemVer|must be a string/, version);
  }
  // build metadata 对 updater 不可区分，允许它等于允许发布两个同版本产物
  assert.throws(() => parseAppVersion("2.1.0+20260818"), /build metadata/);
});

test("profile is fixed by the pre-release marker", () => {
  assert.equal(profileForVersion("2.1.0"), PROFILE_PRODUCTION);
  assert.equal(profileForVersion("2.1.0-beta.1"), PROFILE_BETA);
  assert.equal(profileForVersion("2.1.0-rc.1"), PROFILE_BETA);
  assert.deepEqual(APP_PROFILES, [PROFILE_PRODUCTION, PROFILE_BETA]);
  assert.throws(() => assertAppProfile("development"), /must be one of/);
});

test("pre-release builds stay distinguishable from each other", () => {
  assert.notEqual(parseAppVersion("2.1.0-beta.1").version, parseAppVersion("2.1.0-beta.2").version);
  assert.notEqual(parseAppVersion("2.1.0-beta.1").version, parseAppVersion("2.1.0").version);
});

test("the handshake requires an exact version match and a matching profile", () => {
  assert.deepEqual(
    assertAppVersionHandshake({
      appVersion: "2.1.0-beta.1",
      profile: PROFILE_BETA,
      expectedVersion: "2.1.0-beta.1",
    }),
    { appVersion: "2.1.0-beta.1", profile: PROFILE_BETA },
  );

  assert.throws(
    () => assertAppVersionHandshake({
      appVersion: "2.1.0-beta.2",
      profile: PROFILE_BETA,
      expectedVersion: "2.1.0-beta.1",
    }),
    /handshake failed/,
  );

  assert.throws(
    () => assertAppVersionHandshake({
      appVersion: "2.1.0-beta.1",
      profile: PROFILE_PRODUCTION,
      expectedVersion: "2.1.0-beta.1",
    }),
    /belongs to the beta profile/,
  );

  assert.throws(
    () => assertAppVersionHandshake({
      appVersion: "2.1.0",
      profile: PROFILE_BETA,
      expectedVersion: "2.1.0",
    }),
    /belongs to the production profile/,
  );
});

test("every generated target carries the version from package.json", async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(APP_VERSION_FULL, manifest.version);

  const [esm, rust, tauriConfig, cargo] = await Promise.all([
    readFile(path.join(projectRoot, "shared", "app-version.generated.mjs"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "src", "app_version_generated.rs"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "Cargo.toml"), "utf8"),
  ]);

  assert.equal(esm, renderEsmConstant(manifest.version));
  assert.equal(rust, renderRustConstant(manifest.version));
  assert.equal(JSON.parse(tauriConfig).version, manifest.version);
  assert.match(cargo, new RegExp(`^version = "${manifest.version}"$`, "m"));
});

test("the app identifier matches the bundle and the Rust constant", async () => {
  const [tauriConfig, rustIdentity] = await Promise.all([
    readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "src", "app_identity.rs"), "utf8"),
  ]);

  assert.equal(JSON.parse(tauriConfig).identifier, APP_ID);
  assert.match(rustIdentity, new RegExp(`APP_ID: &str = "${APP_ID}"`));
  // 单实例键要能把三套实例分开
  assert.equal(singleInstanceKey("production"), `${APP_ID}:production`);
  assert.notEqual(singleInstanceKey("production"), singleInstanceKey("beta"));
});

test("the version writers keep pre-release markers intact", () => {
  assert.match(renderEsmConstant("2.1.0-beta.1"), /"2\.1\.0-beta\.1"/);
  assert.match(renderRustConstant("2.1.0-beta.1"), /"2\.1\.0-beta\.1"/);
  assert.equal(
    JSON.parse(replaceJsonVersion('{\n  "version": "0.1.0"\n}', "2.1.0-beta.1")).version,
    "2.1.0-beta.1",
  );
  assert.match(
    replaceCargoVersion('[package]\nversion = "0.1.0"\n', "2.1.0-beta.1"),
    /^version = "2\.1\.0-beta\.1"$/m,
  );
});
