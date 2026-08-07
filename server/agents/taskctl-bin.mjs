import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Agents call the board through `taskctl`, so the board provisions the command
 * itself instead of depending on a global `npm link`. The shim is rewritten on
 * every start so it keeps pointing at this checkout.
 */
export async function ensureTaskctlBin({ binDirectory, cliPath, nodePath = process.execPath }) {
  await mkdir(binDirectory, { recursive: true });
  const shimPath = path.join(binDirectory, "taskctl");
  await writeFile(
    shimPath,
    `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(cliPath)} "$@"\n`,
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
