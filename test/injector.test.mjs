import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const cdpSource = await readFile(new URL("../shared/codex-cdp.mjs", import.meta.url), "utf8");
const runtimeSource = await readFile(
  new URL("../scripts/codex-injector-runtime.mjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("the resident injector supervises the fixed local Taskboard service", () => {
  assert.match(source, /function createTaskboardSupervisor/);
  assert.match(source, /await isReachable\(taskboardHealthUrl\)/);
  assert.match(source, /ensureInFlight/);
  assert.match(source, /await supervisor\.ensure\(\)/);
  assert.match(source, /it will be restarted automatically/);
  assert.match(source, /AbortSignal\.timeout\(1_500\)/);
});

test("the CDP bridge accepts only service ensure and native Skill composer prefill actions", () => {
  assert.match(source, /const hostBindingName = "__codexTaskboardHostV1"/);
  assert.match(runtimeSource, /request\.action === "ensure"/);
  assert.match(runtimeSource, /request\.action === "prefill-task-composer"/);
  assert.match(runtimeSource, /request\.instruction\.length <= 1_024/);
  assert.match(runtimeSource, /request\.skillPath\.length <= 1_024/);
  assert.doesNotMatch(runtimeSource, /skillDisplayName/);
  assert.match(source, /function prefillTaskComposerViaCdp/);
  assert.doesNotMatch(source, /skillDisplayName/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: `\$\$\{skillName\}` \}\)/);
  assert.match(source, /data-composer-overlay-floating-ui/);
  assert.match(source, /button\[data-list-navigation-item="true"\]/);
  assert.match(source, /getAttribute\("aria-selected"\) === "true"/);
  assert.match(source, /\[skill-mention-name\]/);
  assert.match(source, /skill-mention-path/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: instruction \}\)/);
  assert.match(source, /Runtime\.bindingCalled/);
  assert.match(runtimeSource, /params\.executionContextId/);
  assert.match(source, /hostResponse/);
  assert.match(source, /if \(keepAlive\) await installTaskboardHostBinding/);
  assert.match(source, /publishHostHeartbeat/);
  assert.match(source, /__codexTaskboardHostHeartbeatV1/);
});

test("the CDP bridge exposes only the fixed Taskboard automation operations", () => {
  assert.match(source, /parseTaskboardAutomationHostRequest/);
  assert.match(source, /reconcileTaskboardAutomation/);
  assert.match(runtimeSource, /request\.action === "automation"/);
  assert.match(source, /function requestCodexAutomationViaCdp/);
  assert.match(source, /new Set\(\[\s*"list-automations",\s*"automation-create",\s*"automation-update",\s*\]\)/);
  assert.match(source, /bridge\.sendMessageFromView\(\{\s*type: "fetch",\s*requestId,/);
  assert.match(source, /method: "POST"/);
  assert.match(source, /vscode:\/\/codex\/\$\{method\}/);
  assert.match(source, /body: JSON\.stringify\(params\)/);
  assert.match(source, /message\.type !== "fetch-response"/);
  assert.match(source, /message\.responseType/);
  assert.match(source, /message\.status/);
  assert.match(source, /message\.bodyJsonString/);
  assert.doesNotMatch(source, /automation-delete/);
  assert.doesNotMatch(source, /automations\.toml/);
});

test("the package injection command remains resident for tab-triggered recovery", () => {
  assert.match(packageJson.scripts.codex, /--launch --watch --open --port 9231/);
  assert.match(packageJson.scripts["codex:inject"], /--watch/);
  assert.match(packageJson.scripts["codex:daemon"], /--daemon --open/);
  assert.match(source, /function startResidentInjector/);
  assert.match(source, /const defaultCodexDebuggingPort = DEFAULT_CODEX_DEBUGGING_PORT/);
  assert.match(source, /port: defaultCodexDebuggingPort/);
  assert.match(source, /--startup-token/);
  assert.match(source, /__codexTaskboardHostStartupTokenV1/);
});

test("the local launcher preserves a running Codex and starts a separate loopback instance", () => {
  assert.match(source, /AGENT_TASKBOARD_HOST: readEnv\("HOST"\)\?\.trim\(\) \|\| "127\.0\.0\.1"/);
  // 装到 /Applications 后 projectRoot 是只读的，隔离实例的 Electron 目录必须能被
  // 调用方指到别处（安装版给的是 profile 数据目录）。
  assert.match(source, /const launcherStatePath = readEnv\("CODEX_LAUNCHER_DIR"\)/);
  assert.match(source, /const launcherCodexUserDataPath = path\.join\(launcherStatePath, "codex-user-data"\)/);
  assert.match(source, /async function launchCodex[\s\S]*?Contents", "MacOS", executableName/);
  assert.match(source, /`--user-data-dir=\$\{launcherCodexUserDataPath\}`/);
  assert.match(source, /CODEX_ELECTRON_USER_DATA_PATH: launcherCodexUserDataPath/);
  assert.match(source, /detached: true/);
  assert.match(source, /function stopLaunchedCodex/);
  assert.match(source, /stopLaunchedCodex\(codexProcess\)/);
  assert.doesNotMatch(source, /Codex is already running without this CDP port/);
  assert.doesNotMatch(source, /function codexIsRunning/);
});

/**
 * `--shared-profile` 是安装版用的：Codex 没在跑时借它自己的用户目录带端口拉起，
 * 用户看到的就是平时那个 Codex；已经在跑时仍然隔离，因为单实例锁不允许事后加端口。
 * 借来的实例不归启动器所有，退出时不能连它一起关掉。
 */
test("the shared-profile launch adopts an idle Codex and never closes it", () => {
  assert.match(source, /else if \(arg === "--shared-profile"\) options\.sharedProfile = true;/);
  assert.match(source, /function codexClientRunning\(appPath\)/);
  assert.match(source, /const isolated = !options\.sharedProfile \|\| codexClientRunning\(options\.appPath\)/);
  assert.match(source, /launchCodex\(options\.appPath, options\.port, \{ isolated \}\)/);
  assert.match(source, /child\.taskboardOwned = isolated/);
  assert.match(source, /if \(child\?\.taskboardOwned === false\) return;/);
});

/**
 * 同名 Skill 会在补全下拉里出现多次——实测 Codex 同时扫 `~/.agents/skills` 与
 * `~/.codex/skills`，两边各一份就是两个候选，而按钮上没有任何能分辨路径的属性。
 *
 * 两条都不能丢：
 *  - 高亮项现在标的是 `aria-current`，`aria-selected` 是旧写法。只认旧写法时，
 *    多候选场景就只剩「候选恰好一个」这条兜底，必然落空并超时。
 *  - 光选高亮项还不够：它可能是另一份拷贝。要挨个试到 mention 的路径对上为止，
 *    否则看板会把任务挂到别人的 Skill 上。
 */
test("the skill mention tries every same-named candidate until the path matches", () => {
  assert.match(source, /candidate\.getAttribute\("aria-current"\) === "true"/);
  assert.match(source, /candidate\.getAttribute\("aria-selected"\) === "true"/);
  assert.match(source, /const CANDIDATE_ATTEMPTS = 4;/);
  // 高亮项排在最前先试，它是用户直接回车会得到的那份。
  assert.match(source, /const order = highlighted === -1/);
  assert.match(source, /status: mention\.selectedPath === skillPath \? "matched" : "mismatch"/);
  assert.match(source, /rejectedPaths\.push\(/);
  // 全试完还是不对时要报出试过哪些路径，只说「选错了」没法排查。
  assert.match(source, /试过 \$\{rejectedPaths\.join\("、"\)\}/);
});

/** `--no-supervisor`：服务归调用方管时绝不自己再起一个，否则会和 sidecar 抢端口。 */
test("the injector never starts a second board when the caller owns the service", () => {
  assert.match(source, /else if \(arg === "--no-supervisor"\) options\.supervise = false;/);
  assert.match(source, /function createTaskboardSupervisor\(\{ detached, supervise = true \}\)/);
  assert.match(source, /if \(!supervise\) throw new Error\(/);
  assert.match(source, /supervise: options\.supervise/);
});

test("the local launcher retries a renderer swap during the first injection", () => {
  assert.match(source, /function initialInjectionCanRetry/);
  assert.match(source, /Taskboard iframe did not finish loading in the Codex renderer/);
  assert.match(runtimeSource, /export async function waitForStableTargetSet/);
  assert.match(source, /async function injectInitial\([\s\S]*?timeoutMs = 60_000,/);
  assert.match(source, /Codex renderer changed during initial injection/);
  assert.doesNotMatch(source, /maximumAttempts = 3/);
  assert.match(source, /const firstResults = await injectInitial/);
});

test("renderer replacement does not report an expected load handler failure", () => {
  assert.match(source, /async function republishInjectionScriptIdentifier/);
  assert.match(source, /if \(!cdp\.closed\) throw error/);
  assert.match(source, /republishInjectionScriptIdentifier\(cdp, reconciled\.scriptIdentifier\)/);
  assert.match(source, /republishInjectionScriptIdentifier\(cdp, scriptIdentifier\)/);
});

test("attach reconciles the renderer against a hashed current injection source", () => {
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /__CODEX_TASKBOARD_SOURCE_HASH__/);
  assert.match(source, /sourceHash: window\.__codexTaskboardInjection__\?\.sourceHash \|\| null/);
  assert.match(source, /const injectionScriptIdentifierName = "__CODEX_TASKBOARD_SCRIPT_IDENTIFIER__"/);
  assert.match(source, /scriptIdentifier: window\[\$\{JSON\.stringify\(injectionScriptIdentifierName\)\}\] \|\| null/);
  assert.match(source, /Page\.removeScriptToEvaluateOnNewDocument/);
  assert.match(source, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(source, /reconcileInjectionRuntime/);
  assert.match(source, /expectedSourceHash/);
});

test("the injector ignores auxiliary Codex windows", () => {
  assert.match(cdpSource, /!target\.url\?\.includes\("initialRoute="\)/);
  assert.match(source, /maintainHostHeartbeats/);
  assert.match(source, /Reconnecting stale Codex renderer/);
});

test("a completed web build refreshes an already-open Codex iframe", () => {
  assert.match(packageJson.scripts.build, /--refresh-if-running/);
  assert.match(packageJson.scripts["codex:refresh"], /--refresh/);
  assert.match(source, /async function refreshTaskboardFrames/);
  assert.match(cdpSource, /function codexDebuggingPorts/);
  assert.match(cdpSource, /--remote-debugging-port=/);
  assert.match(source, /taskboard\.reloadFrame\(\)/);
  assert.match(source, /__codex_taskboard_refresh/);
  assert.doesNotMatch(source, /restartResidentInjectorForRefresh/);
  assert.doesNotMatch(source, /process\.kill\(pid, "SIGTERM"\)/);
});

test("the resident injector hot-reloads its source without replacing the watcher", () => {
  assert.match(source, /let \{ source, sourceHash \} = await currentInjectionSource\(\{ panel: !options\.automationOnly \}\)/);
  assert.match(source, /latestInjection\.sourceHash !== sourceHash/);
  assert.match(source, /injectedTargets\.forEach\(\(connection\) => connection\.close\(\)\)/);
  assert.match(source, /injectedTargets\.clear\(\)/);
  assert.match(source, /source = latestInjection\.source/);
  assert.match(source, /sourceHash = latestInjection\.sourceHash/);
});

test("the injected iframe follows the configured local service port", () => {
  assert.match(source, /const taskboardPageUrl = `\$\{taskboardOrigin\}\/\?host=codex`/);
  assert.match(source, /window\.__CODEX_TASKBOARD_URL__ = \$\{JSON\.stringify\(taskboardPageUrl\)\}/);
});
