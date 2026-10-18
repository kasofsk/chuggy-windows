/**
 * Task Scheduler's own command, `schtasks`, run with `execFile` and never a
 * shell. An answer is the exit code and both streams. A command that could not
 * start, or that ran past its cap, is answered with code -1 and why on its
 * stderr.
 */

import { execFile } from "node:child_process";

/**
 * @typedef {object} TaskSchedulerAnswer
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 *
 * @typedef {(argv: readonly string[]) => Promise<TaskSchedulerAnswer>} TaskScheduler runs `argv[0]` with the rest as its arguments
 */

/** The cap on one call, which guards a hung scheduler and not a slow one. */
const taskSchedulerCallTimeoutMs = 60_000;

/** @type {TaskScheduler} */
export function taskSchedulerCalled(argv) {
  const [command, ...rest] = argv;
  return new Promise((resolve) => {
    execFile(
      command,
      rest,
      {
        timeout: taskSchedulerCallTimeoutMs,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) resolve({ code: 0, stdout, stderr });
        else if (typeof error.code === "number")
          resolve({ code: error.code, stdout, stderr });
        else resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
      },
    );
  });
}
