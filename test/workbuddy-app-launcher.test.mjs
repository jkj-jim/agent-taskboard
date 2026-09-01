import assert from "node:assert/strict";
import { test } from "node:test";

import { createWorkbuddyAppLauncher } from "../server/workbuddy-app-launcher.mjs";

test("an already connected WorkBuddy is left untouched", async () => {
  const commands = [];
  const launcher = createWorkbuddyAppLauncher({
    port: 9240,
    probe: async () => ({ Browser: "WorkBuddy" }),
    execute: async (...command) => commands.push(command),
  });

  assert.deepEqual(await launcher.connect(), {
    state: "connected",
    restarted: false,
    port: 9240,
  });
  assert.deepEqual(commands, []);
});

test("a normal WorkBuddy process is quit and reopened with the debugging port", async () => {
  const commands = [];
  const running = [true, false];
  const probes = [null, { Browser: "WorkBuddy/5.4.5" }];
  const launcher = createWorkbuddyAppLauncher({
    port: 9240,
    execute: async (file, args) => commands.push([file, args]),
    isRunning: async () => running.shift() ?? false,
    probe: async () => probes.shift() ?? null,
    wait: async () => {},
  });

  const result = await launcher.connect();
  assert.equal(result.restarted, true);
  assert.equal(result.version, "WorkBuddy/5.4.5");
  assert.deepEqual(commands, [
    ["/usr/bin/osascript", ["-e", 'quit app "WorkBuddy"']],
    ["/usr/bin/open", [
      "-a",
      "WorkBuddy",
      "--env",
      "WORKBUDDY_REMOTE_DEBUGGING_PORT=9240",
    ]],
  ]);
});

test("the launcher refuses to force-kill WorkBuddy when its own quit flow is blocked", async () => {
  const commands = [];
  const launcher = createWorkbuddyAppLauncher({
    execute: async (file, args) => commands.push([file, args]),
    isRunning: async () => true,
    probe: async () => null,
    wait: async () => {},
    quitAttempts: 2,
  });

  await assert.rejects(launcher.connect(), /没有退出/);
  assert.deepEqual(commands, [
    ["/usr/bin/osascript", ["-e", 'quit app "WorkBuddy"']],
  ]);
});
