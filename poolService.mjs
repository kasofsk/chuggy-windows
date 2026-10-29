/**
 * The service answering for a pool on this machine. Named pipes share one
 * namespace across the machine's users, and any of them may list the names
 * in it and listen on one that is free, so a pool's pipe is never a name
 * known before its run starts, and is asked only while that run holds the
 * pool.
 *
 * A run holds the pool by keeping its lock open for its whole life, opened
 * so that no other open of it succeeds; Windows lets go of it the moment the
 * run ends, however it ends. Holding it, the run writes the pool's record, in
 * its runtime directory, which only this account may open: the pipe fresh to
 * that run, its pid and what it is. The record is believed only while the
 * lock is held, so a pipe another account listens on, under a name a run
 * once had, is never asked anything. Letting go, a run removes its record,
 * then the lock, and only then stops listening.
 */

import { randomBytes } from "node:crypto";
import { constants, readFileSync, rmSync } from "node:fs";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";

import { controlAsked } from "@chuggy/worker-core/control.mjs";

/**
 * @typedef {"run" | "once"} PoolServiceKind what holds the pool: the runner, or one pass
 * @typedef {{pipe: string, pid: number, kind: PoolServiceKind}} PoolServiceRecord
 *
 * @typedef {object} PoolLock a lock held, or a seam standing in for one
 * @property {() => Promise<void>} release lets go of it
 *
 * @typedef {(file: string) => Promise<PoolLock | undefined>} PoolLocking takes the lock at `file`, or answers nothing where another holds it
 *
 * @typedef {object} PoolHold the pool held by this process
 * @property {string} pipe
 * @property {() => Promise<void>} release removes the record and lets go of the lock
 */

/** The record's name in the pool's runtime directory. */
const recordName = "control.json";

/** The lock's name in the pool's runtime directory. */
const lockName = "run.lock";

/** What a claim refused because the pool is held throws, as its `code`. */
export const poolHeldCode = "PoolHeld";

/** What a pipe this runner names is. */
const pipePattern = /^\\\\\.\\pipe\\chuggy-windows-[0-9a-f]{32}$/u;

/** The longest one ask of a service is waited for. */
export const poolServiceAskMs = 10_000;

/**
 * libuv's flag that opens a file on Windows sharing it with no other open,
 * which Node passes through and does not name.
 */
const exclusiveOpenFlag = 0x10000000;

/** A pipe no run has had. */
export function poolServicePipeFresh() {
  return `\\\\.\\pipe\\chuggy-windows-${randomBytes(16).toString("hex")}`;
}

/**
 * Takes the lock as Windows holds one: open, sharing it with no other open,
 * until it is closed or the process ends.
 *
 * @type {PoolLocking}
 */
export async function windowsLocking(file) {
  try {
    const handle = await open(
      file,
      constants.O_RDWR | constants.O_CREAT | exclusiveOpenFlag,
    );
    return { release: () => handle.close() };
  } catch (failure) {
    if (/** @type {NodeJS.ErrnoException} */ (failure).code === "EBUSY")
      return undefined;
    throw failure;
  }
}

/**
 * Whether the lock at `file` is held, found by taking it and letting go at
 * once. Where its directory is not made yet, nothing has ever held it.
 *
 * @param {string} file
 * @param {PoolLocking} locking
 */
async function lockHeld(file, locking) {
  let lock;
  try {
    lock = await locking(file);
  } catch (failure) {
    if (/** @type {NodeJS.ErrnoException} */ (failure).code === "ENOENT")
      return false;
    throw failure;
  }
  if (lock === undefined) return true;
  await lock.release();
  return false;
}

/**
 * The pool's record, or nothing where there is none or it is not one.
 *
 * @param {string} runtime the pool's runtime directory
 * @returns {Promise<PoolServiceRecord | undefined>}
 */
async function recordRead(runtime) {
  try {
    const record = JSON.parse(
      await readFile(win32.join(runtime, recordName), "utf8"),
    );
    if (
      typeof record?.pipe !== "string" ||
      !pipePattern.test(record.pipe) ||
      !Number.isSafeInteger(record?.pid) ||
      (record?.kind !== "run" && record?.kind !== "once")
    )
      return undefined;
    return { pipe: record.pipe, pid: record.pid, kind: record.kind };
  } catch {
    return undefined;
  }
}

/**
 * What holds the pool, where something does: the record, believed because
 * the lock is held. A record whose lock is not held is no run's.
 *
 * @param {string} runtime the pool's runtime directory
 * @param {PoolLocking} [locking]
 * @returns {Promise<PoolServiceRecord | undefined>}
 */
export async function poolServiceFound(runtime, locking = windowsLocking) {
  if (!(await lockHeld(win32.join(runtime, lockName), locking)))
    return undefined;
  return recordRead(runtime);
}

/**
 * Asks the service at `pipe`, answering nothing where there is no pipe or
 * no service on it, and refusing an answer that takes past `withinMs`.
 *
 * @param {string | undefined} pipe
 * @param {import("@chuggy/worker-core/control.mjs").ControlRequest} request
 * @param {number} [withinMs]
 * @returns {Promise<unknown>}
 */
export async function poolServiceAsked(
  pipe,
  request,
  withinMs = poolServiceAskMs,
) {
  if (pipe === undefined) return undefined;
  return poolServiceWithin(pipe, controlAsked(pipe, request), withinMs);
}

/**
 * What an ask of the service at `pipe` answers, refused where it takes past
 * `withinMs`.
 *
 * @template T
 * @param {string} pipe
 * @param {Promise<T>} asking
 * @param {number} [withinMs]
 * @returns {Promise<T>}
 */
export async function poolServiceWithin(
  pipe,
  asking,
  withinMs = poolServiceAskMs,
) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {Promise<never>} */
  const late = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `the service at ${pipe} did not answer within ${String(withinMs / 1000)}s`,
          ),
        ),
      withinMs,
    );
  });
  try {
    return await Promise.race([asking, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** How often a claim takes the lock before it is refused. */
const lockTriesMax = 5;

/** The wait between tries. */
const lockTryWaitMs = 100;

/**
 * The lock taken, tried again a few times where it is held, since `poolServiceFound`
 * holds it for a moment each time it looks; nothing where it stays held.
 *
 * @param {string} file
 * @param {PoolLocking} locking
 */
async function lockTaken(file, locking) {
  for (let tried = 1; ; tried += 1) {
    const lock = await locking(file);
    if (lock !== undefined || tried >= lockTriesMax) return lock;
    await delay(lockTryWaitMs);
  }
}

/**
 * Holds the pool for this process, `kind` of thing that it is, under a pipe
 * fresh to it, which it then listens on. Where the lock is held the claim is
 * refused, by an error whose `code` is `poolHeldCode`, naming what holds it
 * where its record says.
 *
 * @param {string} runtime the pool's runtime directory, already made
 * @param {number} pid
 * @param {PoolServiceKind} kind
 * @param {PoolLocking} [locking]
 * @returns {Promise<PoolHold>}
 */
export async function poolServiceClaimed(
  runtime,
  pid,
  kind,
  locking = windowsLocking,
) {
  const lock = await lockTaken(win32.join(runtime, lockName), locking);
  if (lock === undefined) {
    const holder = await recordRead(runtime);
    throw Object.assign(
      new Error(
        holder === undefined
          ? "this pool is already held here"
          : `this pool is already held here, by ${holder.kind === "run" ? "a runner's service" : "a pass"} as process ${String(holder.pid)}`,
      ),
      { code: poolHeldCode },
    );
  }
  const file = win32.join(runtime, recordName);
  const pipe = poolServicePipeFresh();
  const written = `${file}.new-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(written, `${JSON.stringify({ pipe, pid, kind })}\n`);
    await rename(written, file);
  } catch (failure) {
    await rm(written, { force: true }).catch(() => undefined);
    await lock.release();
    throw failure;
  }
  return {
    pipe,
    release: async () => {
      await rm(file, { force: true }).catch(() => undefined);
      await lock.release();
    },
  };
}

/**
 * Removes the pool's record where it is `pid`'s, for a process ending at
 * once, which cannot wait on anything; Windows lets go of its lock as it
 * ends.
 *
 * @param {string} runtime
 * @param {number} pid
 */
export function poolServiceReleasedNow(runtime, pid) {
  const file = win32.join(runtime, recordName);
  try {
    if (JSON.parse(readFileSync(file, "utf8"))?.pid === pid)
      rmSync(file, { force: true });
  } catch {
    // A record left is believed by no one once its lock is let go.
  }
}

/**
 * Removes records half written by a holder that ended before placing one,
 * which only the pool's holder may do.
 *
 * @param {string} runtime
 * @param {readonly string[]} entries the runtime directory's
 */
export async function poolServiceLeftoversRemoved(runtime, entries) {
  for (const entry of entries)
    if (entry.startsWith(`${recordName}.`))
      await rm(win32.join(runtime, entry), { force: true }).catch(
        () => undefined,
      );
}
