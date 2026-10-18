/**
 * Task Scheduler held in memory, answering `schtasks` argv with the words
 * Windows 11's prints: a task is registered from the file `/Create /XML`
 * names, read as the UTF-16 it must be, and read back by PowerShell's
 * `Export-ScheduledTask` as base64 of its UTF-8. A suite makes any command
 * fail by its argv.
 */

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

/**
 * @typedef {import("./taskScheduler.mjs").TaskSchedulerAnswer} TaskSchedulerAnswer
 *
 * @typedef {object} FakeTaskCall
 * @property {string[]} argv
 * @property {import("node:buffer").Buffer} [file] the bytes of the file `/Create /XML` named, as it read them
 */

/** @param {string} stdout */
const succeeded = (stdout) => ({
  code: 0,
  stdout: `${stdout}\r\n`,
  stderr: "",
});

const missing = {
  code: 1,
  stdout: "",
  stderr: "ERROR: The system cannot find the file specified.\r\n",
};

/**
 * A definition's text from its file, which must open with UTF-16's byte
 * order mark, as `schtasks` requires.
 *
 * @param {import("node:buffer").Buffer} bytes
 */
function definitionRead(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xfe)
    throw new Error("the task's file is not UTF-16 with its byte order mark");
  return bytes.subarray(2).toString("utf16le");
}

/**
 * What `Export-ScheduledTask` answers for the folder and name its script
 * names: the definition as base64 of its UTF-8, or PowerShell's failure.
 *
 * @param {Map<string, string>} tasks
 * @param {string[]} argv
 * @returns {TaskSchedulerAnswer}
 */
function exported(tasks, argv) {
  const named = /-TaskPath '([^']*)' -TaskName '([^']*)'/u.exec(
    argv.at(-1) ?? "",
  );
  const definition =
    named === null ? undefined : tasks.get(`${named[1]}${named[2]}`);
  if (definition === undefined)
    return {
      code: 1,
      stdout: "",
      stderr:
        "Export-ScheduledTask : The system cannot find the file specified.\r\n",
    };
  return succeeded(Buffer.from(definition, "utf8").toString("base64"));
}

/**
 * @param {Map<string, string>} tasks
 * @param {FakeTaskCall} call
 * @returns {TaskSchedulerAnswer}
 */
function answer(tasks, call) {
  if (call.argv[0] === "powershell.exe") return exported(tasks, call.argv);
  const [command, verb, , name] = call.argv;
  if (command !== "schtasks")
    return { code: -1, stdout: "", stderr: `spawn ${command} ENOENT` };
  if (verb === "/Create") {
    call.file = readFileSync(call.argv[5]);
    tasks.set(name, definitionRead(call.file));
    return succeeded(
      `SUCCESS: The scheduled task "${name.slice(name.lastIndexOf("\\") + 1)}" has successfully been created.`,
    );
  }
  const definition = tasks.get(name);
  if (definition === undefined) return missing;
  if (verb === "/Run")
    return succeeded(`SUCCESS: Attempted to run the scheduled task "${name}".`);
  if (verb === "/End")
    return succeeded(
      `SUCCESS: The scheduled task "${name}" has been terminated successfully.`,
    );
  return succeeded(
    `SUCCESS: The parameters of scheduled task "${name}" have been changed.`,
  );
}

/**
 * @param {Record<string, Partial<TaskSchedulerAnswer>>} [failing] what a command answers instead, by its argv joined with spaces, which a suite may change between calls
 */
export function fakeTaskScheduler(failing = {}) {
  /** @type {Map<string, string>} the registered tasks' definitions, by name */
  const tasks = new Map();
  /** @type {FakeTaskCall[]} */
  const calls = [];
  /** @type {import("./taskScheduler.mjs").TaskScheduler} */
  const scheduler = async (argv) => {
    /** @type {FakeTaskCall} */
    const call = { argv: [...argv] };
    calls.push(call);
    const instead = failing[argv.join(" ")];
    if (instead !== undefined)
      return { code: 1, stdout: "", stderr: "", ...instead };
    return answer(tasks, call);
  };
  return {
    scheduler,
    tasks,
    calls,
    failing,
    /** Every argv asked, in order. */
    argvs: () => calls.map((call) => call.argv),
  };
}
