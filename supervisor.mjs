/**
 * The service a pool's task runs: `run` as a child, started again
 * `restartDelayMs` after it ends for any reason but the plane denying the
 * pool, which no restart would change. That is what systemd's `Restart=` and
 * `RestartPreventExitStatus=` do for chuggy-linux, since Task Scheduler
 * restarts nothing a task's process ended with.
 *
 * A denial is remembered beside the size and time of writing of the pool
 * file the denied run started on, so the task's repetition does not start a
 * denied pool's runner again until the pool is registered again, which
 * writes the file anew.
 *
 * Ending the task ends its console host and every process on that console
 * at once, this one among them, before any can clean up; where it ends only
 * the host, this process's console input fails, and it ends itself. `run`
 * is started on no console, so it outlives both and ends once its input
 * closes, having cleaned up. Every line either
 * prints goes to the service's log, kept below `serviceLogBytesMax` by moving
 * it aside once, and lines past `serviceLogLinesQueuedMax` waiting to be
 * written are dropped and counted.
 */

import { spawn } from "node:child_process";
import {
  appendFile,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createInterface } from "node:readline";

import { deniedExitStatus } from "./serviceTask.mjs";

/**
 * @typedef {object} SupervisedChild a started `run`
 * @property {(onLine: (line: string) => void) => void} lines every line it prints, as it prints them
 * @property {Promise<number>} exited its exit status, -1 where it ended by no status of its own
 *
 * @typedef {object} SupervisorHost
 * @property {string} poolFile
 * @property {string} logFile
 * @property {string} deniedFile where a denial is remembered
 * @property {() => SupervisedChild} start starts `run` for the pool file
 * @property {(ms: number) => Promise<void>} sleep
 * @property {Promise<void>} parentGone settles once what started this process is gone
 * @property {() => Date} now
 */

/** The wait before a run that ended is started again, as chuggy-linux's unit waits. */
export const restartDelayMs = 10_000;

/** The lines the log may have waiting to be written before more are dropped. */
export const serviceLogLinesQueuedMax = 10_000;

/** The size past which the service's log is moved aside, to one older copy. */
export const serviceLogBytesMax = 10 * 1024 * 1024;

/** What tells `run` its input closing means the service ended. */
export const supervisedVariable = "CHUGGY_WINDOWS_SUPERVISED";

/**
 * `run` started for the pool file by this Node and CLI, its input held open
 * by this process and both its outputs read line by line.
 *
 * @param {{node: string, cli: string, poolFile: string, environment: Readonly<Record<string, string | undefined>>}} service
 * @returns {SupervisedChild}
 */
export function supervisedChild(service) {
  const child = spawn(
    service.node,
    [service.cli, "run", "--pool", service.poolFile],
    {
      env: { ...service.environment, [supervisedVariable]: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      // On no console: Windows ends every process on the task's console the
      // moment its host is ended, before any can clean up, while this one
      // ends once its input closes, having cleaned up.
      detached: true,
      windowsHide: true,
    },
  );
  const exited = new Promise((resolve) => {
    child.once("error", () => resolve(-1));
    // Windows reports a process ended by force as an unsigned 32-bit status.
    child.once("exit", (code) => resolve(code === null ? -1 : code | 0));
  });
  return {
    lines: (onLine) => {
      for (const stream of [child.stdout, child.stderr])
        createInterface({ input: stream, crlfDelay: Infinity }).on(
          "line",
          onLine,
        );
    },
    exited: /** @type {Promise<number>} */ (exited),
  };
}

/**
 * Settles once this process's console input ends or fails, which it does
 * the moment the console host above it is gone. The input is read, so the
 * service is not run by hand from a console it should leave alone.
 *
 * @param {NodeJS.ReadableStream} stdin
 * @returns {Promise<void>}
 */
export function inputEnded(stdin) {
  return new Promise((resolve) => {
    for (const event of ["end", "error", "close"])
      stdin.once(event, () => resolve());
    stdin.resume();
  });
}

/**
 * What identifies the pool file as written: a registration writes it anew.
 *
 * @param {string} poolFile
 */
async function poolFileStamp(poolFile) {
  const stats = await stat(poolFile).catch(() => undefined);
  return stats === undefined
    ? undefined
    : { size: stats.size, mtimeMs: stats.mtimeMs };
}

/**
 * Whether the pool was denied as its file now stands. A denial of an
 * earlier file is forgotten.
 *
 * @param {SupervisorHost} host
 */
export async function supervisorDenied(host) {
  const text = await readFile(host.deniedFile, "utf8").catch(() => undefined);
  if (text === undefined) return false;
  const stamp = await poolFileStamp(host.poolFile);
  let remembered;
  try {
    remembered = JSON.parse(text);
  } catch {
    remembered = undefined;
  }
  if (
    stamp !== undefined &&
    remembered?.size === stamp.size &&
    remembered?.mtimeMs === stamp.mtimeMs
  )
    return true;
  await rm(host.deniedFile, { force: true });
  return false;
}

/**
 * Remembers a denial of the pool file as it stood when the denied run
 * started, so a registration written while that run was still going is not
 * the file remembered as denied.
 *
 * @param {SupervisorHost} host
 * @param {{size: number, mtimeMs: number} | undefined} stamp
 */
async function deniedRemembered(host, stamp) {
  if (stamp !== undefined)
    await writeFile(host.deniedFile, `${JSON.stringify(stamp)}\n`);
}

/**
 * A line in the service's log, the log moved aside first once it is past its
 * bound. A line that cannot be written is dropped, since nothing could be
 * told of it.
 *
 * @param {SupervisorHost} host
 * @param {string} line
 */
export async function serviceLogged(host, line) {
  try {
    const size = (await stat(host.logFile).catch(() => undefined))?.size ?? 0;
    if (size > serviceLogBytesMax)
      await rename(host.logFile, `${host.logFile}.1`);
    await appendFile(host.logFile, `${host.now().toISOString()} ${line}\n`);
  } catch {
    // The log is the only place a failure here could be told.
  }
}

/**
 * Runs `run` until the plane denies the pool or the parent is gone. Writes
 * to the log are queued, so its lines stay in order.
 *
 * @param {SupervisorHost} host
 * @returns {Promise<number>} the exit status
 */
export async function supervisor(host) {
  const log = serviceLog(host);
  const gone = host.parentGone.then(() => "Gone");
  for (;;) {
    if (await supervisorDenied(host)) {
      await log(
        `the plane denied ${host.poolFile}; register the pool again to serve it`,
      );
      return 0;
    }
    const stamp = await poolFileStamp(host.poolFile);
    const child = host.start();
    child.lines((line) => void log(line, false));
    const ended = await Promise.race([child.exited, gone]);
    if (ended === "Gone") {
      await log("the task ended, so the service ends");
      return 0;
    }
    if (ended === deniedExitStatus) {
      await deniedRemembered(host, stamp);
      await log(
        `the plane denied ${host.poolFile}; the service ends until it is registered again`,
      );
      return 0;
    }
    await log(
      `run exited ${String(ended)}; starting it again in ${String(restartDelayMs / 1000)}s`,
    );
    if ((await Promise.race([host.sleep(restartDelayMs), gone])) === "Gone") {
      await log("the task ended, so the service ends");
      return 0;
    }
  }
}

/**
 * The service's log as a queue of lines written in order. A line of `run`'s
 * past `serviceLogLinesQueuedMax` waiting is dropped, and how many were is
 * written before the next line that is not; the service's own are never
 * dropped.
 *
 * @param {SupervisorHost} host
 * @returns {(line: string, own?: boolean) => Promise<void>}
 */
function serviceLog(host) {
  let written = Promise.resolve();
  let queued = 0;
  let dropped = 0;
  return (line, own = true) => {
    if (!own && queued >= serviceLogLinesQueuedMax) {
      dropped += 1;
      return written;
    }
    queued += 1;
    const count = dropped;
    dropped = 0;
    written = written.then(async () => {
      if (count > 0)
        await serviceLogged(
          host,
          `dropped ${String(count)} lines the log could not keep up with`,
        );
      await serviceLogged(host, line);
      queued -= 1;
    });
    return written;
  };
}
