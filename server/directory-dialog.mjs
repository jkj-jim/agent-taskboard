import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { ApiError } from "./database.mjs";
import { existingDirectory } from "./ai-chat-catalog.mjs";

const execFileAsync = promisify(execFile);

/**
 * A dialog waits on a person, so the only useful timeout is one that releases
 * the request if the window is forgotten rather than one that races the user.
 */
const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;

/** AppleScript's own code for "the user pressed Cancel". */
const USER_CANCELED = "-128";

/**
 * Opens the operating system's own folder chooser and returns what was picked.
 *
 * The board runs in three shells today — a browser tab, a Codex iframe and a
 * WorkBuddy iframe — and a fourth, a standalone client, is planned. None of
 * them can name a directory on their own: a web page never learns the absolute
 * path behind `<input type="file">`, and the two hosts only expose their own
 * pickers through injection that is meant to go away. The server, however, is
 * an ordinary process on the same machine in every one of those shells, so
 * asking it to open the dialog is the one answer that outlives all of them.
 * Swapping `osascript` for a client-side dialog later changes this function and
 * nothing above it.
 */
export async function chooseDirectory({ prompt = "选择项目文件夹" } = {}) {
  if (process.platform !== "darwin") {
    throw new ApiError(
      501,
      "DIRECTORY_DIALOG_UNSUPPORTED",
      `${process.platform} 上还没有实现文件夹选择框，请改用 taskctl project create --workspace-path`,
    );
  }

  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "osascript",
      ["-e", `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`],
      { encoding: "utf8", timeout: DIALOG_TIMEOUT_MS },
    ));
  } catch (error) {
    if (String(error?.stderr ?? error?.message ?? "").includes(USER_CANCELED)) {
      throw new ApiError(409, "DIRECTORY_SELECTION_CANCELED", "已取消选择文件夹");
    }
    throw new ApiError(
      500,
      "DIRECTORY_DIALOG_FAILED",
      `无法打开文件夹选择框：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // `POSIX path of` ends every directory with a separator; `path.resolve` drops
  // it, and leaves `/` alone.
  const workspacePath = await existingDirectory(path.resolve(stdout.trim()));
  if (!workspacePath) {
    throw new ApiError(400, "INVALID_FIELD", "选中的位置不是一个可用的目录");
  }
  return { workspacePath, name: path.basename(workspacePath) };
}
